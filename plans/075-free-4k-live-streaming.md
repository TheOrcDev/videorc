# Plan 075: 4K live streaming goes free — on Videorc desktop and Videorc Web

> **Executor instructions**: One execution unit is one named slice, in order.
> Run every verification command and confirm the expected result before moving
> to the next slice. If a STOP condition occurs, stop and report; do not
> improvise. Slices D1–D5 live in this repo; slices W1–W3 live in the sibling
> private `videorc-web` repo and are specified here by contract.
>
> **Drift check (run first)**:
> `git diff --stat febb5ca8..HEAD -- crates/videorc-backend/src/entitlements.rs crates/videorc-backend/src/recording.rs apps/desktop/src/renderer/src/lib/entitlements.ts apps/desktop/src/renderer/src/lib/entitlement-ui.ts apps/desktop/src/renderer/src/lib/premium-upgrade.ts apps/desktop/src/renderer/src/lib/capture.ts docs/distribution.md`
> If any in-scope file changed since this plan was written, compare the
> excerpts below against live code before proceeding. On mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (desktop) + S (web copy)
- **Risk**: LOW-MED (boundary move, no new media code; risk is copy/test drift
  and support load from more 4K sessions)
- **Depends on**: nothing in-repo; W-slices need videorc-web access
- **Category**: direction, product boundary, docs
- **Planned at**: commit `febb5ca8`, 2026-09-28
- **Status**: PLANNED

## Owner decision being implemented

4K live streaming becomes free because it does not cost Videorc anything to
serve: the encode runs on the user's machine and the RTMP upload rides the
user's own bandwidth to the provider's ingest — exactly the argument that made
multistreaming free on 2026-09-15 (Plan 016 addendum). Premium keeps the
features Videorc pays to serve: cloud AI, live captions, Orcle co-host, and
Noise Cleanup.

**Scope reading (confirm with the owner at S0, then proceed)**: "streaming
quality" is one tiered rectangle today — Basic 1920×1080@30 / 6,000 kbps vs
Premium 3840×2160@60 / 30,000 kbps. This plan collapses the whole rectangle:
Basic gets the full streaming ceiling (which unlocks 1080p60 and the YouTube
4K30 profile together). A carve-out that frees 4K30 but keeps 1080p60 paid
would invert the quality ladder (a free tier that streams 4K but not 1080p60)
and keep two limit structs alive for one leftover cell; the plan treats that
as a rejected shape. If the owner wants that shape anyway, STOP and re-plan.

After this plan, the streaming-quality tier surface is GONE. The Premium
gates that remain: `cloud-ai`, `noise-cleanup`, `live-cohost` (and the
server-bound caption/AI token minting). `livestreaming` and `multistreaming`
capabilities stay `enabled` on the wire for every tier, unchanged.

## What already exists (do not rebuild)

4K live streaming is already implemented and shipping for Premium:

- The `stream-youtube-4k30` preset (3840×2160@30, 30,000 kbps) is a supported
  stream profile; true 4K is YouTube-only and exact-profile by design
  (`streamVideoProfileValidationReason`, `capture.ts:1035-1046`).
- Per-platform output capabilities already cap Twitch/Kick/X/TikTok/Instagram/
  custom at 1080p (`streamPlatformOutputCapabilities`, `capture.ts:751-806`).
- Mixed-destination sessions share one encode and downgrade to the
  provider-safe shared profile (`resolveProviderStreamOutputPlan`,
  `capture.ts:940-1013`); a 4K stream session is effectively a single-YouTube
  (or YouTube-only) session. Unchanged by this plan.
- The backend enforces the tier at session start
  (`validate_session_entitlements`, `recording.rs:18493`) from the
  entitlement snapshot's streaming limits.

The ONLY thing that changes is who is entitled to the existing ceiling.

## Current state (excerpts that will change)

Backend tier constants (`crates/videorc-backend/src/entitlements.rs:19-29`):

```rust
const BASIC_STREAMING_MAX_WIDTH: u32 = 1920;
const BASIC_STREAMING_MAX_HEIGHT: u32 = 1080;
const BASIC_STREAMING_MAX_FPS: u32 = 30;
const BASIC_STREAMING_MAX_BITRATE_KBPS: u32 = 6000;
// Premium streams up to the supported 1080p60 profiles and 4K30; Basic stays
// at 1080p30. ...
const PREMIUM_STREAMING_MAX_WIDTH: u32 = 3840;
const PREMIUM_STREAMING_MAX_HEIGHT: u32 = 2160;
const PREMIUM_STREAMING_MAX_FPS: u32 = 60;
const PREMIUM_STREAMING_MAX_BITRATE_KBPS: u32 = 30_000;
```

Renderer mirror (`apps/desktop/src/renderer/src/lib/entitlements.ts:15-30`):
`BASIC_STREAMING_LIMITS` (1080p30/6000) vs `PREMIUM_STREAMING_LIMITS`
(4K60-ceiling/30000), with `DEFAULT_BASIC_ENTITLEMENTS.limits.streaming =
BASIC_STREAMING_LIMITS`.

Renderer upsell copy (`entitlement-ui.ts:128-131`): an over-limit stream
profile on Basic renders
`"3840x2160 @ 30 FPS requires Videorc Premium. Your streaming limit is …"`,
and `isPremiumUpgradeMessage` (a `/\bPremium\b/i` sniff in
`premium-upgrade.ts`) turns any reason containing "Premium" into an upgrade
URL + "View Premium" button (`recording-tab.tsx:133-149`, preset lock rows in
`video-preset-select-items.tsx:101-106`).

Capability matrix (`docs/distribution.md:412-442`): the
"Livestreaming destinations" row grants Free "up to 5 destinations at the
Basic HD limits" and Premium "higher streaming quality (1080p60 / 4K30)"; the
enforcement paragraph says "The tier changes streaming quality, cloud AI,
live captions, Orcle, and Noise Cleanup".

Web contract (unchanged mechanically): videorc.com's `/api/ai/capabilities`
returns a premium boolean plus an Ed25519-signed token `{premium, tier, exp}`;
the desktop derives ALL limits locally from the tier. There is no
streaming-quality field on the wire, so the web API and token schema need no
change — the web work is product copy and sales surfaces.

## Desktop slices (this repo)

### D0 — Owner confirmation (no code)

Confirm the scope reading above: the whole streaming-quality tier collapses
(1080p60 + 4K30 + the 30,000 kbps ceiling go free), Premium remains cloud AI,
live captions, Orcle, Noise Cleanup. Record the answer in this plan.

### D1 — Backend: one shared streaming limit for every tier

In `entitlements.rs`:

- Replace the `BASIC_STREAMING_*` / `PREMIUM_STREAMING_*` pairs with one set
  of `STREAMING_MAX_*` constants at the current premium values (3840, 2160,
  60, 30_000), following the `STREAMING_MAX_DESTINATIONS` precedent. Keep the
  comment honest: the rectangular 4K×60 ceiling still does not make 4K60 a
  supported stream profile — profile validation still rejects it.
- `basic_limits()` and `premium_limits()` collapse to one `streaming_limits()`
  (or `basic_limits() == premium_limits()`; prefer deleting the duplicate).
  `EntitlementLimits`/`StreamingEntitlementLimits` protocol shapes and
  `schema_version` stay unchanged — the numbers move, the wire does not.
- Update the module comment ("Only streaming QUALITY is tiered" is no longer
  true) and the hydration comment at `main.rs:11455` ("the Premium gates:
  cloud AI, co-host, streaming quality").
- Update tests in `entitlements.rs` that pin Basic to 1080p30/6000
  (`entitlement_default_snapshot_is_basic_...`,
  `premium_streaming_allows_supported_1080p60_and_4k30_while_basic_stays_hd`
  → rename to assert the limits are identical across tiers, like
  `recording_limits_are_identical_across_tiers`,
  `entitlement_env_can_never_unlock_premium_in_release_builds` — the env
  guard now proves CloudAi/NoiseCleanup/LiveCohost stay locked, not a
  streaming cap, `current_entitlements_keep_release_builds_basic_without_env`,
  `account_hydration_resolution_is_fail_closed`).
- Update `recording.rs` tests that assert Basic rejects big stream profiles
  (`recording.rs:25668-25680` and `:32964-32970` expect
  `"allows livestreaming up to 1920x1080"`). Replace with: Basic ACCEPTS the
  exact YouTube 4K30 and 1080p60 profiles, and every tier still rejects a
  profile above the shared ceiling (e.g. 4K60 stream or >30,000 kbps) with the
  existing message. Keep `validate_session_entitlements` itself unchanged —
  it reads the snapshot and now passes because the snapshot moved.

Verify: `cargo test -p videorc-backend entitlement`,
`cargo test -p videorc-backend`, `cargo fmt --check --all`,
`cargo clippy -p videorc-backend -- -D warnings`.

### D2 — Renderer: mirror the limits and strip Premium from streaming copy

- `entitlements.ts`: collapse `BASIC_STREAMING_LIMITS` /
  `PREMIUM_STREAMING_LIMITS` into one `STREAMING_LIMITS` constant at the
  premium values (keep both exported names only if churn elsewhere is large;
  prefer one name). `DEFAULT_BASIC_ENTITLEMENTS` uses it. Update
  `entitlements.test.ts`.
- `entitlement-ui.ts`: `videoProfileEntitlementGate` for `kind: 'streaming'`
  must never produce a reason containing "Premium" — same rule as the
  multistream destination cap (`destinationsLimitGate`'s comment: the toast
  layer sniffs "Premium" into an upgrade prompt). With the limits collapsed,
  `shouldOfferPremiumForProfileLimit` can no longer fire for streaming;
  delete the streaming branch of the Premium wording rather than leaving it
  reachable-looking. Recording copy is already non-tiered; leave it.
- `premium-upgrade.test.ts:14-17` pins the streaming-quality reason as a
  Premium upgrade message — flip it to assert the over-ceiling streaming
  reason is NOT an upgrade message.
- `entitlement-ui.test.ts`: update the profile-gate cases (Basic + YouTube
  4K30 → allowed; over-ceiling profile → honest limit copy, no upgradeUrl;
  unsupported true-4K non-YouTube profile → existing
  `streamVideoProfileValidationReason` copy, unchanged).
- Preset picker (`video-preset-select-items.tsx`) needs no code change: the
  lock row follows the gate. By-eye: on a Basic-forced build
  (`VIDEORC_PREMIUM_FEATURES=0`), `YouTube 4K30`, `YouTube 1080p60` and
  `Stream-safe 1080p60` presets show unlocked; performance verdicts
  ("Verified"/"Too heavy") still render; the LVF record+stream 4K warning
  (`capture.ts:818-834`) still shows. Go-live preflight
  (`premiumRequiredIssueMessage`) must no longer be able to surface a
  streaming-quality Premium issue.

Verify: `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`.

### D3 — Docs and public changelog

- `docs/distribution.md` Open-Core Capability Boundary: move streaming
  quality out of Premium. The "Livestreaming destinations" row becomes
  "Included: up to 5 destinations at full streaming quality (1080p60 /
  YouTube 4K30)" for Free, "Included." for Premium; add the cost rationale
  sentence next to the multistreaming one (encode + upload run on the user's
  machine, costs Videorc nothing to serve, since this plan's date). Fix the
  enforcement bullet: the tier now changes cloud AI, live captions, Orcle,
  and Noise Cleanup — not streaming quality.
- `README.md`: the feature bullets may now say 4K livestreaming is free
  (matches the repo tagline "go live on 5 platforms free"); keep the claim
  provider-honest (true 4K is YouTube; other platforms cap at 1080p).
- Add a public changelog entry under `changelog/` for the release that ships
  this (user-facing: "4K and 1080p60 live streaming are now free on every
  plan"), per `changelog/README.md`; no internal gate names in it.
- Plan 016 gets a dated addendum (like the 2026-09-15 one) pointing here.

Verify: `pnpm changelog:check`, `pnpm format:check`.

### D4 — Basic-tier proof gate

Prove the gate opens end-to-end, not just in unit tests: with
`VIDEORC_PREMIUM_FEATURES=0` (the downgrade-only env that forces Basic), a
session configured with the exact `stream-youtube-4k30` profile must pass
`validate_session_entitlements` and reach session start; the same env with a
4K60 stream request must still be rejected with the shared-ceiling message.
Prefer extending the existing entitlement-gate coverage in the multistream
smoke (`scripts/smoke-multistream-app.mjs`) or `pnpm smoke:dev`'s gate
checks over a new scratch script; if a new probe is genuinely needed, promote
it properly under `scripts/` with a package script (Process And Script
Rules).

Verify: the extended smoke passes 3 consecutive runs; `pnpm test:scripts`.

### D5 — Broader gates before handoff

This change touches session-start validation in `recording.rs` (test-only
edits) and entitlement constants — not encoding profiles, colorimetry,
container, or fps handling themselves. Still, because the boundary now lets
Basic users start 4K stream sessions, run once on a macOS host before
handoff: `pnpm smoke:recording-matrix` (both passes) and
`pnpm smoke:multistream`. If the macOS host is unavailable, say so
explicitly in the PR and list the D1/D2/D4 gates that did run.

## Videorc Web slices (sibling private repo, by contract)

No API, token, or schema change: the web keeps minting `{premium, tier, exp}`
for the cloud features. The web work is sales and copy truthfulness — after
the desktop release ships, no Videorc surface may still sell streaming
quality as Premium.

### W1 — Pricing and premium pages

- `/premium` (the page `VIDEORC_PREMIUM_URL` deep-links to from the desktop
  upsell buttons): remove streaming quality (4K / 1080p60 streaming) from the
  Premium feature list; add it to the Free column of any plan-comparison
  table. Premium sells cloud AI, live captions, Orcle co-host, Noise Cleanup.
- Homepage / features / any "Free forever" section: state free live
  streaming up to 4K (YouTube true-4K, 1080p elsewhere — keep the same
  provider honesty as the desktop copy) alongside the existing free 4K
  recording and 5-destination multistreaming claims.

### W2 — Sales-surface audit

Audit every surface that enumerates Premium benefits and remove streaming
quality from each: checkout/billing page feature list, the Creem product
description if it lists features, upgrade/marketing emails and templates, FAQ
and docs pages, and social/OG descriptions. The Ed25519 entitlement token and
`/api/ai/capabilities` are explicitly out of scope (no change).

### W3 — Release comms

The desktop `changelog/` entry from D3 flows to `/changelog` and
`/releases/<version>` automatically via the existing R2 `changelog.json`
publication — verify the entry renders. Coordinate the W1/W2 copy deploy with
the desktop release that ships D1: web copy may go live first (it gives away
nothing), but must not lag a shipped desktop release, and the premium page
must never sell a capability the current release gives away.

## Rollout order

1. D0 owner confirmation.
2. D1–D4 land in one desktop PR (D5 evidence recorded on it).
3. W1–W2 land in videorc-web, deployed before or with the desktop release.
4. D3's changelog entry ships with the release; W3 verifies publication.

Existing Premium accounts lose nothing; nothing needs migration. A Basic user
on an old desktop build keeps the old local 1080p30 cap until they update —
acceptable, no server coordination needed.

## What must NOT change

- True 4K streaming stays YouTube-only and exact-profile
  (`stream-youtube-4k30`); per-platform 1080p caps stay
  (`streamPlatformOutputCapabilities`).
- The multistream shared-encode downgrade to provider-safe profiles stays;
  the destination cap stays 5 for every tier.
- The LVF record+stream 4K warning (`capture.ts:818-834`) stays until its
  incident plan retires it.
- `livestreaming`/`multistreaming` capability ids stay on the wire as
  `enabled`; `schema_version` stays 1.
- `VIDEORC_PREMIUM_FEATURES` stays downgrade-only; the signed-token
  hydration path is untouched.
- Cloud AI, live captions, Orcle co-host, and Noise Cleanup stay Premium and
  server-bound.

## STOP conditions

- The owner wants a narrower move (free 4K30 but 1080p60 stays Premium) or a
  different Premium lineup: stop, re-plan the limits shape.
- videorc-web turns out to enforce or display streaming-quality limits
  server-side anywhere beyond copy (unexpected per the desktop contract):
  stop and extend the W-slices with that evidence.
- D5's matrix or multistream smoke regresses on the unchanged media path:
  stop; this plan must not paper over a media regression with an
  entitlement change.
- Any slice would require weakening the Premium gates on cloud AI, captions,
  co-host, or Noise Cleanup.

## Test plan

- Rust: entitlement snapshot tests (limits identical across tiers; env
  downgrade still forces Basic and still locks the cloud features);
  `validate_session_entitlements` accepts YouTube 4K30 / 1080p60 on Basic and
  rejects over-ceiling profiles on every tier.
- TS: entitlements mirror equality with the backend numbers; profile gate
  never emits "Premium" for streaming; upgrade-message sniff test flipped;
  preset picker gate cases.
- Smokes: extended Basic-tier gate proof (D4), `pnpm smoke:multistream`,
  one macOS `pnpm smoke:recording-matrix` run (D5).
- By-eye on a Basic-forced dev build: unlocked stream presets, honest
  unsupported-profile copy, no "View Premium" on any streaming-quality
  surface.

## Done criteria

- [ ] D0 owner confirmation recorded in this plan.
- [ ] One shared streaming limit across Basic/Premium/Developer in backend
      and renderer; all listed tests updated and green.
- [ ] No streaming-quality reason can produce a Premium upgrade prompt.
- [ ] `docs/distribution.md` matrix, README, Plan 016 addendum, and public
      changelog entry updated.
- [ ] D4 Basic-tier proof and D5 gates recorded (or the macOS-blocked note).
- [ ] W1–W3 done in videorc-web: premium/pricing/marketing surfaces no
      longer sell streaming quality; changelog rendered.
- [ ] `plans/README.md` entry updated with the outcome.

## Ledger

| Slice | Status | Evidence |
| ----- | ------ | -------- |
| D0    | TODO   |          |
| D1    | TODO   |          |
| D2    | TODO   |          |
| D3    | TODO   |          |
| D4    | TODO   |          |
| D5    | TODO   |          |
| W1    | TODO   |          |
| W2    | TODO   |          |
| W3    | TODO   |          |
