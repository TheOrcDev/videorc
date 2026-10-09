# Plan 170: Golem library and onboarding, the same on videorc.com and in the app

> **Executor instructions**: one phase at a time, in order (B can run beside
> A). Web work goes to the videorc-web repo, desktop work to this repo; both
> build on the Golem PRs (#647 desktop, #75 web) and their plans 164, 168 and 169. Run each phase's verification. Owner-overridable choices are marked
> ⚑. Do not improvise on the data model or the routes.

## Status

- **Priority**: P1 (the owner wants the Golem ready for people to see the
  final product)
- **Effort**: XL, 5 phases
- **Risk**: MEDIUM-HIGH: a new account data store (user content on our
  servers), a public marketing page, sync between two apps, image cost
- **Depends on**: plan 169 (the house look, `POST /api/ai/cohost/avatar/set`,
  the desktop look panel), unmerged in #647 / #75
- **Planned at**: desktop `56e18f1e` (`plan-164-golem-b`), web `912b32b4`
  (`plan-164-golem-web`), 2026-10-09
- **Route**: Orchestrator. A (web data + routes) Implementation fit 9; B
  (official art) orchestrator + owner review; C (web pages) UI/Product Design
  fit 9; D (desktop) Implementation + UI fit 9; E orchestrator. Model lane
  `opus` (Fable credits out).

| Phase                                                        | Where   | Status  |
| ------------------------------------------------------------ | ------- | ------- |
| A: The account library and its routes                        | web     | PLANNED |
| B: The official library (Golem + Orc, Goblin, Pirate, Robot) | both    | PLANNED |
| C: `/golem`, `/golem/create`, `/account/golems`              | web     | PLANNED |
| D: The library and the same onboarding in the app            | desktop | PLANNED |
| E: Gates, captures, privacy, docs, acceptance                | both    | PLANNED |

## The owner's ask (2026-10-09)

"Plan to do everything the same on Videorc web. We need some kind of
onboarding, in steps.

1. You can create your own Golem or Orc or Goblin or Pirate or Robot or
   whatever and use it inside your live stream. Show how it looks in a live
   stream and what we can create.
2. A simple text area describing the avatar, and an optional image for
   context.
3. Personality and some context, if needed, about the streamer, product or
   anything.
4. Now generate; it goes in the library of the user creating it.

We also want our own library of avatars. The first is this Golem; later we
generate four more. Do the same onboarding inside the app, and people who
prefer can do it on the web."

Owner answers (2026-10-09):

- **One account library.** Every avatar made on the web or in the app is
  saved to the user's Videorc account; both show the same library; picking
  one on either side makes it the Golem, and the app downloads its pictures.
- **Official free, creating Premium.** Anyone can browse the onboarding and
  use Videorc's official avatars; generating your own is Premium, with the
  same daily image allowance as the app.
- **Official set**: the Golem plus Orc, Goblin, Pirate and Robot, generated
  in the house look in this plan; the owner reviews each before it ships.
- **Step 4 output**: the four still poses (idle, talk, laugh, think) in the
  house look, saved to the library. "Make it Alive" on a library avatar
  makes the animated pet later (the existing app creator).

## What exists (facts)

Web (`plan-164-golem-web`, research 2026-10-09):

- Better Auth's `bearer()` plugin (`lib/auth.ts:93-117`): every route using
  `getCurrentSession()` accepts the web cookie and the desktop bearer.
  Premium: `getUserEntitlementSnapshot` (`lib/entitlements/snapshot.ts:153`);
  the co-host gate ladder `decideCohostAccess` (`lib/ai/jobs.ts:821`); the
  error envelope `cohostJsonError` (`lib/ai/cohost-route.ts:114-126`).
- The look route `app/api/ai/cohost/avatar/set/route.ts` +
  `lib/ai/cohost-avatar-route.ts` (`handleCohostAvatarSet`, injectable):
  idle as an edit of `[anchor, inspiration?]`, then talk/laugh/think in
  parallel; per-image reservation in `ai_usage_events` (`cohost-avatar`,
  daily cap 24); streamed JSON with base64 PNGs; **stores nothing**. Vercel
  caps request bodies at 4.5 MB (inspiration ≤ about 3 MB decoded).
- Storage: account avatars use Vercel Blob (public) or a private Neon S3
  bucket with a 302-to-presigned route (`lib/account/avatar-route.ts`);
  private Vercel Blob with signed URLs exists in `lib/ai/object-storage.ts`
  (`signVercelBlobUrl`). Account deletion: `app/account/settings/actions.ts:286-304`.
- DB: Drizzle on Neon (`db/schema.ts`), `user.id` is text; migrations
  `db/migrations/00NN_*.sql`, next is `0019`; the guard test allows only
  idempotent DDL, **no INSERT/UPDATE** (official rows cannot be seeded in
  SQL); no soft-delete pattern exists.
- Pages: marketing feature pages follow `app/orcle/page.tsx` (+ copy module
  `lib/orcle-guide.ts`, `createPageMetadata`, JSON-LD, OG images); indexable
  pages need a `seoRoutes` entry (`lib/metadata.ts`), the pinned list in
  `tests/metadata.test.ts`, a `public/llms.txt` line, nav/footer links. The
  account area is gated by `app/account/layout.tsx`; tabs in
  `components/account/account-nav.tsx`. shadcn on the web has no dialog,
  textarea, label, select, radio, checkbox, toast or drop zone; forms use
  server actions + `useActionState`; no multi-step flow exists.
- Marketing assets live in `public/marketing/…`; there is no creature art on
  the web.

Desktop (`plan-164-golem-b`):

- Plan 169's look panel (`components/golem-look-section.tsx`,
  `hooks/use-golem-look.ts`), backend `cohost_avatar.rs` (create / redo /
  keep / discard / draft.get, drafts under `<persona>/drafts/<id>/`, kept
  pictures named `<state>-<tag>.png`), "Make it Alive" into the creator,
  Test your Golem dialog, the default Golem (four bundled pictures).
- Persona (`cohostSettings.persona`): id, name, personality, images, avatar
  (still / alive), motion, reactions; `cohostSettings.notes` (facts the
  Golem answers from, ≤ 4000) and `tone`.

## Decisions (⚑ = owner may override)

**The library (account data)**

- D1. **A library avatar is a whole sidekick**: `name` (1-24),
  `description` (what was asked for, ≤ 600), `personality` (≤ 1200),
  `context` (≤ 4000: about the streamer, the stream, the product; becomes the
  Golem notes in the app), the four still poses, `lookVersion`, `source`
  (`generated`), timestamps. The inspiration picture is used for
  generation only and **never stored**.
- D2. Web tables (migration `0019_add_golem_library.sql`, guarded DDL):
  - `golem_avatars`: `id` text uuid PK, `user_id` FK cascade, the D1
    fields, `image_keys` jsonb `{ idle, talk, laugh, think }` (object keys),
    `opaque` jsonb, `created_at`, `updated_at`. Index `(user_id, created_at)`.
  - `golem_profiles`: `user_id` PK FK cascade, `active_avatar_id` text
    nullable (a user avatar id or `official:<slug>`), `updated_at` (the sync
    clock, D12).
  - Hard delete with best-effort object cleanup (no soft-delete pattern
    exists); account deletion deletes the objects (hook in `deleteAccount`).
- D3. **Storage**: the four PNGs per avatar in **private** storage under
  `golem-avatars/<userId>/<avatarId>/<state>-<rand>.png`, reusing the
  object-storage provider switch (private Vercel Blob by default, private S3
  supported), read through `GET /api/golem/avatars/:id/:state` (session
  required, ownership checked, 302 to a short-lived signed URL; the desktop
  backend follows the redirect). Env `VIDEORC_GOLEM_STORAGE_*` falling back
  to the AI object storage env.
- D4. Limits: **30 avatars per user** ⚑ (`VIDEORC_GOLEM_LIBRARY_LIMIT`); a
  create beyond it answers 409 `golem-library-full`. The daily image
  allowance is the existing avatar cap (a create = 4 images, a redo = 1),
  shared by web and app.

**Routes (web; cookie or bearer; `{ error: { code, message } }`)**

- D5. `POST /api/golem/avatars` (create): body `{ name, description?,
inspiration?, personality?, context? }` (description or inspiration
  required; inspiration ≤ 3 MB decoded, the client downscales). Runs the
  plan 169 set generation (the same core as `handleCohostAvatarSet`, same
  gates and reservation), stores the delivered PNGs, inserts the row only
  when the idle exists, and responds with the avatar (`id`, fields, `poses:
{ <state>: { url, opaque } | null }`, `failed`) **and** the base64 PNGs
  for the desktop (`pngBase64` per state) so the app needs no second
  download. `maxDuration 180`, streamed like the set route.
- D6. `GET /api/golem/avatars` (list mine, newest first, with pose URLs),
  `GET /api/golem/avatars/:id`, `PATCH /api/golem/avatars/:id` (name,
  personality, context), `DELETE /api/golem/avatars/:id`,
  `POST /api/golem/avatars/:id/redo { state }` (talk / laugh / think; one
  image; replaces that pose's object), `GET /api/golem/avatars/:id/:state`
  (the image, D3).
- D7. `GET /api/golem/profile` / `PUT /api/golem/profile { activeAvatarId }`
  (a user avatar or `official:<slug>`; official ones work without Premium).
- D8. `GET /api/golem/official` (public, cacheable): the catalog (D10).
- D9. Capabilities gain `cohost.golemLibrary { enabled, count, limit }`
  (additive key; an older desktop treats it as off).

**The official library**

- D10. **Catalog in code, art as static files**, the same in both repos:
  `slug`, `name`, `tagline`, `personality`, `context` (a sample: "This
  Golem greets followers by name and keeps the stream cosy."), poses at
  `public/golem/official/<slug>/<state>.webp` (web) and
  `apps/desktop/src/renderer/src/assets/golem/official/<slug>/` (desktop,
  bundled, so official avatars work offline and signed out); masters in
  `assets/brand/golem/official/<slug>/`. The Golem is `official:golem` and
  its art is the existing default set.
- D11. The four new official characters, made in the house look by the plan
  169 pipeline (style anchor + description), reviewed by the owner before
  they ship ⚑ wording:
  - **Orc** "Grok": "a burly, friendly green orc with small tusks, a
    braided top-knot, leather shoulder guards and a wide grin"; personality
    "Loud, loyal, cheers every follower like a battle won."
  - **Goblin** "Nib": "a small cheeky green goblin with huge ears, a patched
    vest and a coin pouch"; personality "Sly, quick, loves a deal and a
    joke at the streamer's expense."
  - **Pirate** "Captain Barnacle": "a jolly round pirate captain with a
    tricorn hat, an eye patch, a striped shirt and a big beard"; personality
    "Booming, theatrical, calls viewers his crew."
  - **Robot** "Bolt": "a rounded retro robot with a screen face showing
    simple eyes, a short antenna and chunky metal hands"; personality
    "Polite, precise, delighted by every stat."

**Sync between web and app**

- D12. **The library is the source of truth for linked avatars.** A persona
  gains `libraryAvatarId` (string, or `official:<slug>`, or absent for a
  local-only Golem such as an imported pack). Picking an avatar on either
  side writes `golem_profiles.active_avatar_id`. The app syncs on launch,
  on Golem tab open and on window focus (at most once a minute): when the
  server's `updated_at` is newer than the app's last sync and the active id
  differs, it downloads that avatar's poses, writes them locally (plan 169's
  `<state>-<tag>.png`), and applies name, personality and context (context
  → `cohostSettings.notes`); a local edit of a linked avatar's name,
  personality or context is pushed with `PATCH` (last write wins). Signed
  out or offline: nothing changes; official avatars still apply from the
  bundled art.
- D13. Plan 169's local draft flow becomes the library flow in the app:
  **Create** calls `POST /api/golem/avatars`, the backend writes the
  returned PNGs as the draft (unchanged UI), **Keep this look** = select it
  (`PUT /api/golem/profile`) and apply, **Discard** = `DELETE` the library
  avatar, **Redo** = the library redo. Nothing is lost if the user only
  generates (it is in the library on both sides).

**The onboarding (identical steps on web and in the app)**

- D14. Four steps, one shared copy document (`docs/golem-onboarding-copy.md`
  in this repo, mirrored into a web copy module and a desktop copy module;
  a test on each side pins the step titles):
  1. **Meet your sidekick**: "Create your own Golem, Orc, Goblin, Pirate,
     Robot, or anything you like, and put it in your live stream." A
     **live demo**: a stream-shaped frame (a gameplay-like placeholder)
     with the Golem in its corner cycling idle → a follower arrives →
     speech bubble "Welcome to the horde, Mira!" with the talk pose →
     laugh, on a loop (built from the four poses and the bubble, no
     video file). **What you can create**: the official five as cards
     ("Start from this one" uses it directly, free). **What it does**:
     greets followers, answers questions about you, reacts to chat, shows
     on stream and in recordings, can come alive. Primary: **Create my
     own**.
  2. **Describe it**: a textarea ("A grumpy stone golem with a mossy back
     and a lantern…") with three example chips, and an optional picture
     ("a pet, a logo, a sketch, a selfie"), downscaled in the browser to
     1024 px / ≤ 3 MB. Next is enabled with text or a picture.
  3. **Give it a personality**: Name (required, 1-24), Personality (≤ 1200,
     example chips), and **About you** (optional, ≤ 4000: "what you stream,
     your schedule, your product, links; your Golem answers from this").
  4. **Generate**: a summary of steps 2 and 3, the allowance ("Uses 4 of
     your 24 images today"), **Create my Golem**. While it works (about one
     to three minutes): the four pose slots fill in (idle first). Result:
     the four poses with **Redo** on talk / laugh / think, **Use as my
     Golem**, and "Saved to your library". On the web, **Open in Videorc**
     (a new `videorc://golem` deep link, D18) and **Download the app** for
     people without it.
- D15. Gates: steps 1 to 3 work signed out on the web (input kept in
  `sessionStorage`, the picture as a data URL ≤ 3 MB); step 4 asks to sign
  in (returning to step 4 with the input intact) and then checks Premium; a
  free account sees the Premium offer and "Start from an official Golem"
  instead of Generate. In the app the same gates use the existing Premium
  and Cloud AI consent hints.
- D16. Entry points: web `/golem` (marketing page: step 1's content with
  SEO, OG, JSON-LD, llms.txt, nav "Golem" next to Orcle) with **Create
  yours** → `/golem/create`; `/account/golems` (the library: mine + official,
  Use, Rename, edit personality / about you, Redo a pose, Delete, Make it
  Alive opens the app). In the app: the Golem tab shows **My Golems**
  (official + mine, with the active one marked) above the look panel; **New
  Golem** opens the four-step onboarding as a full-height sheet; the first
  launch with the default Golem shows a one-line invitation to step 1.

- D18. **Open in Videorc** is a new `videorc://golem` deep link. Today the
  app's `open-url` handler only routes the account sign-in callback
  (`videorc://account/callback`), so Phase D teaches it this second host:
  bring the main window forward, open the Golem tab, and run a library sync
  (D12) at once instead of waiting for focus. Any other host stays ignored.
  "Make it Alive" on the web uses the same link with `?alive=<avatarId>`,
  which opens the app's creator for that avatar after the sync.

**Copy and privacy**

- D17. The web privacy page and the app's Cloud AI lines say: avatars you
  create (their pictures, name, personality and about-you text) are kept in
  your Videorc account so you can use them on any computer; the picture you
  give for inspiration is used once and not kept; deleting an avatar or
  your account deletes them.

## Phase A: The account library and its routes (web)

1. Migration `0019_add_golem_library.sql` (D2) + Drizzle schema + the guard
   test passing.
2. `lib/golem/library.ts`: store (CRUD, limit, profile), storage (D3) with
   the provider switch and a 302 image route, cleanup on delete and in
   `deleteAccount`.
3. Routes D5 to D9, injectable handlers like the co-host routes, reusing the
   plan 169 generation core (refactor `handleCohostAvatarSet` into a
   generator function + a persistence step; the existing set route keeps
   working for older desktops until D ships, then is removed in E).
4. Tests: create stores four objects and one row; a failed idle stores
   nothing and meters nothing; a failed pose stores three; redo replaces one
   object; ownership on every route; library full; profile set to an
   official slug without Premium; profile set to someone else's avatar
   refused; delete removes objects; account deletion removes objects;
   cookie and bearer both work.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

## Phase B: The official library (both repos)

1. A maintained script in this repo, `scripts/golem-official-generate.mjs`
   (package script `golem:official`), that takes a slug, calls the gateway
   with the plan 169 prompts and the style anchor (key read from
   `~/.config/videorc/ai-gateway-key` or `AI_GATEWAY_API_KEY`, never
   printed), writes the masters to `assets/brand/golem/official/<slug>/`,
   and exports the four WebPs at the default Golem's scale (the haze clear,
   80.2 % rule from `assets/brand/golem/README.md`) to the desktop assets
   folder.
2. Generate Orc, Goblin, Pirate and Robot (D11); the owner reviews each set
   (redo a pose or the whole set until approved). STOP until approved.
3. Copy the approved exports to the web `public/golem/official/<slug>/`;
   catalog constants in both repos (D10) with a test that every catalog
   entry has its four files.

## Phase C: `/golem`, `/golem/create`, `/account/golems` (web)

Follows the web's design tokens (monochrome glass, both themes) and its
shadcn set; add via the shadcn CLI: `textarea`, `label`, `dialog`,
`toggle-group`; a drop zone composed from `input[type=file]` + a styled
label (the avatar form pattern).

1. `/golem` (D16, D14 step 1): `lib/golem-guide.ts` copy, the live demo
   component (`components/golem/stream-demo.tsx`: the four official poses +
   the bubble on a timeline; reduced-motion shows a static frame), the
   official gallery, "What it does", FAQ; metadata, OG/Twitter images,
   JSON-LD, `seoRoutes`, `tests/metadata.test.ts`, `public/llms.txt`, nav
   and footer.
2. `/golem/create` (D14, D15): a client stepper (URL `?step=1..4`,
   back/next, progress dots, keyboard: ⌘↵ next), state in `sessionStorage`,
   sign-in round trip back to step 4, Premium gate, the generate call
   (`fetch` with the cookie, a 190 s client timeout, pose slots filling as
   the response arrives), the result actions.
3. `/account/golems` (D16): the library grid (official + mine), detail sheet
   (rename, personality, about you, redo a pose, delete with confirm, Use as
   my Golem, Open in Videorc); `ACCOUNT_NAV_ITEMS` + `AccountMenu` entries.
4. Privacy page (D17).

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; captures
of every step and the library in both themes at 390 px and 1280 px.

## Phase D: The library and the same onboarding in the app (desktop)

1. Backend: `videorc_api` clients for D5 to D8; `cohost_library.rs` (list,
   apply, select, delete, patch, redo; download and write poses; sync per
   D12 with a persisted `lastLibrarySyncAt`); persona `libraryAvatarId`
   (Rust + TS + strict schema + fixtures); plan 169's create / redo / keep /
   discard re-pointed per D13; official avatars apply from bundled art.
   Main process: the `videorc://golem` host (D18) next to the account
   callback, with a test that unknown hosts stay ignored.
2. Renderer: **My Golems** section (official + mine, active marked, Use,
   Delete, Make it Alive), the four-step onboarding sheet (same steps and
   copy as the web, D14; the plan 169 panel becomes step 4's result view),
   the first-launch invitation, the Cloud AI line (D17).
3. Tests: sync applies a newer server choice and pushes a local edit; signed
   out leaves everything; official apply works offline; the onboarding gates
   and the step copy match the shared document.

Gates: TS + Rust gates, `cargo test -p videorc-backend -- cohost_library
cohost_avatar golem`, `pnpm build`, `pnpm check:renderer-assets`, captures
of the library and each step in both themes.

## Phase E: Gates, privacy, docs, acceptance (both)

- Remove the plan 169 `/api/ai/cohost/avatar/set` route once the desktop
  uses the library route (or keep it as the generation core's thin wrapper
  if anything still calls it).
- Docs: `docs/golem.md` (library, sync, onboarding), web
  `docs/ai-gateway.md` and a new web `docs/golem-library.md` (tables,
  storage, routes, limits, deletion).
- Owner acceptance: create one Golem on the web, see it in the app within a
  minute of focusing the window, pick an official one in the app and see the
  web library mark it active, delete one on each side.

## STOP conditions

- Any route lets one user read, change or delete another user's avatar.
- The inspiration picture is persisted anywhere.
- An avatar row exists without its idle image, or objects remain after a
  delete or an account deletion.
- The official art is not owner-approved (Phase B gate).
- The app overwrites a local-only Golem (no `libraryAvatarId`) during sync.

## Out of scope

- Storing Alive pet packs in the library (Make it Alive stays an app
  creator; a later plan can sync packs).
- Sharing avatars between users or a public gallery of user avatars.
- Editing pictures by hand (upload) in the library.

## Open questions for the owner

1. D4: 30 avatars per user?
2. D11: the four names and personalities (Grok, Nib, Captain Barnacle,
   Bolt)?
3. D16: should the web nav show "Golem" beside "Orcle", or replace it
   (Orcle is the old name of the Golem)?
