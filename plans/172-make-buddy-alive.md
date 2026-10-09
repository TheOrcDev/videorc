# Plan 172: Make Buddy alive, for real

> **Executor instructions**: phases in order; B waits for the owner's review
> of A. Desktop work goes to #647 (`plan-164-golem-b`), web work to #79
> (`plan-170-golem-web`) unless the owner says otherwise ⚑. Owner-overridable
> choices are marked ⚑.

## Status

- **Priority**: P1 (owner, 2026-10-09: "make now a plan to make it alive, we
  need to finish that part")
- **Effort**: XL, 6 phases (A to F)
- **Risk**: MEDIUM-HIGH: image cost and quality (about 50 generated sheets
  for the official five), pack sizes (download, bundle, the 64 MiB atlas
  budget), large uploads past Vercel's 4.5 MB body cap, the first real
  creation through the deployed web
- **Depends on**: plans 168 (pack format, animator, creator), 169 (house
  look), 170 (library), 171 (Buddy names, Neon storage); web #75 and #79
  deployed for Phases C and F
- **Planned at**: desktop `258066ad` (`plan-164-golem-b`), web `3725b099`
  (`plan-170-golem-web`), 2026-10-09
- **Route**: Orchestrator. A and B orchestrator + owner review (art). C
  Implementation fit 9 (web storage and routes). D Implementation fit 9
  (backend sync, creator). E UI/Product Design fit 9 (the web player). F
  Release-adjacent, orchestrator. Model lane `opus` (Fable credits out).

| Phase                                                       | Where   | Status  |
| ----------------------------------------------------------- | ------- | ------- |
| A: The pipeline, proven on Buddy the Golem                  | both    | PLANNED |
| B: The other four official packs, and how they ship         | both    | PLANNED |
| C: Alive packs in the account library (web)                 | web     | PLANNED |
| D: The app: apply, sync, and Make it Alive everywhere       | desktop | PLANNED |
| E: Alive on videorc.com (the player, the demo, the library) | web     | PLANNED |
| F: Deploy, a real creation, and the on-stream acceptance    | both    | PLANNED |

## The owner's answers (2026-10-09)

- **Official Buddies**: all five come alive; Buddy the Golem's pack ships
  inside the app, and Golmar, Nib, Captain Barnacle and Bolt download from
  videorc.com the first time they are used, then work offline.
- **Who makes the official packs**: Claude generates them with a maintained
  script running the creator's own pipeline; the owner approves each from
  contact sheets of every row before it ships.
- **Sync**: a Buddy you make alive follows your account: the pack is saved
  with the Buddy in the library, alive on every computer you sign in to,
  and moving on videorc.com.
- **Where**: Make it Alive runs in the app; on videorc.com the button opens
  Videorc with that Buddy ready.

## What exists (facts)

- **Pack format** (plan 168 D1 to D4): one folder, `manifest.json` (page-pet
  v1), one atlas `mascot.webp` (3200 × 5120, 640 px cells: 25 gaze cells, 12
  reactions, 3 extras `talk-a`, `talk-b`, `wave`), `buddy.json`; created
  packs add `build-report.json` and `provenance.json`. Guards: 32 MB per
  file, 128 MB per pack, ≤ 64 frames. The compositor pre-scales atlases per
  leg within a 64 MiB budget (D5).
- **Persona**: `avatar: { kind: 'still' } | { kind: 'alive', packId }`;
  pack ids are a uuid (the persona's own, in `<root>/<persona>/pets/`) or
  `bundled:<name>` (read-only second root shipped as
  `buddy-assets/bundled`, from `apps/desktop/resources/buddy/`, empty
  today).
- **Creator** (plan 168 F): `buddy_pet_create.rs` runs a web build session
  (`POST /api/ai/cohost/pet/builds`, identity, one sheet per call) and the
  Rust builder (`buddy_pet_build/`: cut, isolate, register, pack;
  `build_pack` is public). RPCs `cohost.pet.creation.start/status/cancel`,
  `cohost.pet.identity`, `cohost.pet.sheet.generate`, `cohost.pet.build`,
  `cohost.pet.save`; the wizard is `buddy-pet-creator.tsx`, reachable from
  Make it Alive (persona idle as reference). Never run against a real web.
- **Web** (#75, not deployed): `lib/ai/cohost-pet-prompts.ts`
  (`PET_PROMPT_VERSION = 2`, the house look, layouts per sheet kind),
  identity via `VIDEORC_AI_PET_VISION_MODEL`, sheets via
  `VIDEORC_AI_PET_IMAGE_MODEL` (both set in Vercel production), allowance
  3 creations a month, 9 base sheets + 6 redos, pilots 3 per creation.
  Plan 168's model probe (S-E1) is still owed.
- **Library** (plans 170, 171): `buddy_avatars` rows with four poses in the
  private Neon bucket `buddy-avatars`; poses served by a 302 to a signed
  URL; `PUT /api/buddy/profile`; the app's `cohost_library.rs` sync; apply
  sets the persona to Still today.

## Decisions (⚑ = owner may override)

**The official packs (Phases A, B)**

- D1. **One pipeline, two drivers.** `pnpm buddy:alive --slug <slug>`
  (desktop `scripts/buddy-alive-generate.mjs` + `scripts/lib/`) runs the
  creator's pipeline headless: identity notes from the official idle
  master, the pilot, then the nine sheets as image edits of the accepted
  neutral, with the exact prompt words of web `cohost-pet-prompts.ts`
  (copied with a version check, like `buddy:official` does for the look),
  then the Rust builder through a dev-only example,
  `cargo run -p videorc-backend --example buddy_pack -- <sources> <out>`
  (never shipped). Sources and masters stay outside the bundle
  (`assets/brand/buddy/official/<slug>/alive/`); the script writes a
  contact sheet per row for review. The key is read like `buddy:official`.
- D2. **Phase A doubles as plan 168's model probe (S-E1)**: Buddy the Golem
  first, recording per sheet the native size, alpha, identity hold, cost
  and the builder's verdict in `docs/ai-gateway.md`. If the prompts need
  changing, they change in the web module first (`PET_PROMPT_VERSION` 3)
  and the script copies them.
- D3. **Size.** Measure the lossless atlas. If a pack is over 6 MB ⚑, the
  official and synced copies use an alpha-lossless, colour-lossy WebP
  (quality 92 ⚑) and/or 512 px cells ⚑, chosen by eye on a side-by-side
  at on-stream size; the builder's local output stays lossless.
- D4. **Shipping.** Buddy the Golem's pack is `bundled:buddy` in
  `apps/desktop/resources/buddy/buddy/`. The other four live on the web at
  `public/buddy/official/<slug>/alive/<version>/` (`manifest.json`,
  `mascot.webp`, `buddy.json`), and the official catalog fixture gains
  `alive: { version, files: { name, bytes, sha256 }[] }` per character
  (both repos, byte-identical). The app downloads a pack the first time
  that official Buddy is used or previewed alive, verifies every file's
  size and SHA-256, and keeps it at `<root>/official/<slug>/<version>/`;
  its pack id is `official:<slug>`. A failed or offline download leaves the
  Buddy Still and retries on the next use; nothing half-written is ever
  loaded.
- D5. **Defaults.** The default persona becomes Alive with `bundled:buddy`.
  Using an official Buddy sets Alive with its pack (Still until the
  download lands, then Alive unless the user changed it meanwhile).
- D6. **Review gate** (plan 168 D21, for us): every gaze row and reaction
  sheet of every official pack is approved by the owner from the contact
  sheets and a looping preview video; a rejected row is redone, never
  hand-edited. Nothing ships without the approval line in the PR.

**Alive packs in the account (Phases C, D)**

- D7. **Storage**: a library Buddy may carry one alive pack:
  `buddy-avatars/<userId>/<avatarId>/alive/<packId>/{manifest.json,
mascot.webp, buddy.json}` in the same Neon bucket. Migration
  `0020_add_buddy_alive.sql` adds `alive jsonb` to `buddy_avatars`
  (`packId`, `version`, `cellSize`, `frames`, `files[] {name, bytes,
sha256, key}`, `createdAt`), guarded DDL.
- D8. **Upload past the body cap**: `POST /api/buddy/avatars/:id/alive`
  `{ packId, files: [{ name, bytes, sha256 }] }` returns one presigned PUT
  per file (10 minutes, exact length and content type); the app uploads
  straight to Neon; `POST /api/buddy/avatars/:id/alive/commit` reads the
  objects back, checks sizes, hashes and the manifest rules (the same
  guards as the app's pack loader), then writes the row and deletes any
  previous pack. A commit that fails deletes what was uploaded.
  `GET /api/buddy/avatars/:id/alive/:file` 302s to a signed URL;
  `DELETE /api/buddy/avatars/:id/alive` removes it. Deleting the Buddy or
  the account removes the pack too. Only the S3 provider supports alive
  sync ⚑ (production is Neon); Vercel Blob answers
  `buddy-alive-unsupported`.
- D9. **The library JSON** gains `alive: { packId, version, cellSize,
files[] {name, url, bytes, sha256} } | null` per Buddy; capabilities
  gain `cohost.buddyLibrary.alive: boolean`.
- D10. **App sync**: `cohost.pet.save` on a persona linked to a library
  Buddy uploads the pack (accept + event, retried on the next sync if it
  fails); a persona not linked offers "Save to my library" first ⚑ (a
  local-only Buddy keeps a local-only pack). Apply and sync download a
  Buddy's alive pack into the persona's `pets/` (verified like D4) and set
  Alive; removing a pack in the app removes it from the account when
  linked.
- D11. **Allowance** stays plan 168 D20 ⚑: Premium, 3 creations a month,
  9 base sheets + 6 redos each, pilots capped; official packs, imports,
  sync and rendering are free.

**Make it Alive everywhere (Phases D, E)**

- D12. **Entry points in the app**: My Buddies cards (exists), the
  onboarding result (a "Make it Alive" secondary action after "Use as my
  Buddy"), the Avatar panel (exists), the deep link
  `videorc://buddy?alive=<id>` (exists). Official Buddies are already
  alive, so their cards show "Alive" instead of Make it Alive.
- D13. **On the web**: a pack player (`components/buddy/pet-player.tsx`), a
  port of the app's preview (canvas, gaze follows the pointer, blink,
  click reactions, the talk frames while the bubble shows) with
  `lib/buddy/motion.ts` matching `protocol-fixtures/buddy-motion.json`
  (copied as a web test fixture); `prefers-reduced-motion` shows the
  neutral cell. It animates the `/buddy` stream demo, the official gallery
  and step 1, and library cards with an alive pack. Make it Alive on the
  web keeps opening `videorc://buddy?alive=<id>` with "Download Videorc"
  beside it.

## Phase A: The pipeline, proven on Buddy the Golem (both)

1. The Rust example `buddy_pack` around `build_pack` (reads versioned
   sources, writes the pack and `build-report.json`), with a test that a
   synthetic sheet set builds.
2. `pnpm buddy:alive` (D1): identity, pilot, nine sheets, build, contact
   sheets and a short looping preview (the app's animator through the
   `smoke:buddy-pet` harness or a scripted render) for review.
3. Run it for Buddy the Golem from `golem-master.png`; record the probe
   (D2) and the size decision (D3).
4. STOP for the owner's review (D6). Redo rows until approved.

Gates: `pnpm test:scripts`, the example's test, `cargo clippy`, the probe
table filled.

## Phase B: The other four official packs, and how they ship (both)

1. Run `buddy:alive` for Golmar, Nib, Captain Barnacle and Bolt; owner
   review (D6).
2. `bundled:buddy` in `resources/buddy/buddy/`; the four on the web under
   `public/buddy/official/<slug>/alive/1/`; the catalog fixture's `alive`
   blocks in both repos with tests that every listed file exists with its
   size and hash.
3. Desktop: the official download (D4), `official:<slug>` pack ids, the
   default persona Alive (D5), apply sets Alive; tests for verify-fail,
   offline, and a download landing after the user switched away.

Gates: desktop TS + Rust gates, `smoke:buddy-pet` with `bundled:buddy`,
`pnpm build`, `pnpm check:renderer-assets`; web tests.

## Phase C: Alive packs in the account library (web)

D7 to D9: migration 0020, the presign/commit/get/delete routes, the
validation (a TS port of the manifest rules with the shared fixture
`protocol-fixtures/buddy-pet-manifests.json`), cleanup on Buddy and account
deletion, capabilities. Tests with an in-memory store and a fake S3: a
commit with a wrong hash, a missing file, an oversize file, a bad
manifest, a second pack replacing the first, ownership on every route.

Gates: web typecheck, lint, test, build.

## Phase D: The app: apply, sync, and Make it Alive everywhere (desktop)

D10, D12: upload after save (with the retry), download on apply and sync,
pack removal sync, the onboarding result action, "Alive" on official
cards, "Save to my library" for unlinked Buddies. Rust tests against a
fake web and a fake S3 endpoint; renderer tests for the new actions.

Gates: desktop TS + Rust gates, `smoke:buddy-pet`, `smoke:cohost-fake`,
`pnpm build`, `pnpm check:renderer-assets`, captures of My Buddies and the
creator's save step in both themes.

## Phase E: Alive on videorc.com (web)

D13: the player and motion port with the fixture test, the animated demo,
gallery, step 1 and library cards; captures at 390 and 1280 px in both
themes; the stream demo's frame rate checked (no layout thrash, one
`requestAnimationFrame` per player, paused offscreen).

Gates: web typecheck, lint, test, build.

## Phase F: Deploy, a real creation, and the on-stream acceptance (both)

1. Owner: merge and deploy #75, then #79 (migrations 0018, 0019, 0020;
   the Neon settings are already in production).
2. A real creation on the owner's Premium account from the app: Make it
   Alive on a library Buddy, every row reviewed, saved, synced; the same
   Buddy alive on a second machine or a fresh profile and on
   `/account/buddies`.
3. Plan 168 G4: a 10-minute live stream with fake and real activity, by
   eye on both orientations, the official five each used once,
   `docs/acceptance/<date>-alive-buddy.md`.
4. Docs: `docs/buddy.md` (official alive, sync, Make it Alive),
   `docs/buddy-library.md` (alive routes), `docs/ai-gateway.md` (probe and
   cost), `docs/third-party/page-pet.md` unchanged unless code is ported
   anew.

## STOP conditions

- An official pack ships without the owner's approval line (D6).
- A downloaded pack is loaded before its sizes and hashes verify.
- A pack upload can be committed for another user's Buddy, or survives the
  deletion of its Buddy or account.
- Any atlas over the 64 MiB resident budget at the default stream size.
- The real creation (F2) fails at the web: fix and rerun before
  acceptance.

## Out of scope

- Building packs on the web (the builder stays in the app).
- Sharing packs between users; a public gallery of user packs.
- Automated vision checks of gaze directions (plan 168 D21 stays human).
- Alive creations without Premium.

## Open questions for the owner

1. D3: the 6 MB size line, lossy colour at quality 92, and 512 px cells if
   needed?
2. D8: alive sync only on the S3 (Neon) storage, with Vercel Blob
   unsupported?
3. D10: should an unlinked Buddy offer "Save to my library" before syncing,
   or stay local-only?
4. Web PR: add to #79, or a new stacked PR?
