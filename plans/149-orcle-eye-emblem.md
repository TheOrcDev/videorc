# Plan 149: The Orcle eye, Orcle's official mark

> Executor: implement the phases below in order. Use one isolated worktree of
> current `origin/main` (the shared checkout is often stale and other sessions
> switch its branch), with one branch and one PR per repo. Read `AGENTS.md`,
> `CLAUDE.md` and `.claude/skills/videorc-design/SKILL.md` before any slice.
>
> Commit and push per slice. Run the gates once at the end, per the owner's
> rule. Planning authorizes no merge, release or production change.

## Status and decisions

- **Status: EXECUTED, in review, 2026-10-04.** The owner asked to make the
  "Cybernetic Orc Eye Emblem" Orcle's official symbol and replace the simple
  orc head that plan 119 drew (`OrcleIcon`, #579). Then they said: "Execute
  the entire plan and create a PR." That instruction stands in for the
  sign-off that Phase 2 waited on, so both phases are built.
  - The ⚑ defaults stand: D2 (the glyph has no red) and D3 (the emblem is
    a raster).
  - Still owed by the owner:
    - the rights confirmation;
    - a by-eye check of the glyph and the placements in the running app.
  - **Owner override, 2026-10-04, after S1–S6 were built:** "I want real
    image inside the app not that icon." `OrcleIcon` now draws the real
    emblem image (the 64 px export inside an `<svg>`, so `svg`-based slot
    styles still apply) everywhere Orcle appears: the sidebar, the session
    row, the Stream Manager, popovers and menus. The vector eye from S3 is
    deleted. This overrides D1 (no raster under 24 px) and D2 (no red in the
    icon); D5's emblem placements stay. The owner also said "no checking
    now", so no by-eye pass of the image icon was made.
  - **Built differently from the slices below, on purpose:**
    - S2 has no `srcSet`. Each size ships its 2× file only, and the browser
      scales it down on 1× displays. A 1× file would add bytes for no
      visible gain.
    - S3: the solid weight (fill, bold) drops the plate seam. Cut into a
      solid eye, it floated as a slot at 16 px. The outline weights keep
      the seam. Exact pixel-fitting on 16-unit boundaries was dropped too:
      the eye is all diagonals and curves, so the proof sheet decided
      instead.
    - S4: the consent dialog puts the emblem *beside* the title, not above
      it. That is how permissions onboarding actually leads with the
      Videorc logo, so this is the faithful mirror.
- **Route:** UI/Product Design owns it (fit 9). Model lane: `opus-4.8`
  (scoped, cosmetic, high taste risk in the 16 px glyph). Escalate to
  `fable-5` if the glyph fails the by-eye check twice.
- **Branches:** desktop `feat/149-orcle-eye-emblem`; web (Phase 2)
  `feat/149-orcle-eye-emblem` in `~/projects/videorcweb`.

### What exists today (measured on `origin/main` `932a3b80`)

**The source image.** `~/Downloads/Cybernetic Orc Eye Emblem.png`: 1254 ×
1254 RGBA, 1.5 MB, transparent background. The opaque eye (alpha > 50%)
spans 1194 × 808 at +33+193, so it is about 1.48 : 1 wide, with a soft
glow outside that box. The art is a chrome/stone eye with a black keyline, a
horn spike at top left, a scowling brow plate, riveted cyber plates on the
right, and one LED-red iris.

**How it reads at app sizes.** Composited on `#0D0D0F` (dark) and `#FAFAFB`
(light) at 16, 24, 32, 64 and 128 px:

| Height | Reads as |
| --- | --- |
| 16 px | A grey smudge with a red dot. The silhouette is lost. |
| 24 px | An eye, but the plates and the brow turn to mush. |
| 32 px | A clearly menacing eye. It is the smallest size where it is a logo. |
| 64 px and up | Full detail: rivets, cracks and iris rings. |

The black keyline carries it on porcelain, and the chrome carries it on
black, so one file works in both themes. Test exports from the 1254 master:
the WebP at 128 px is 4.8 KB, and at 256 px it is 13.9 KB (`cwebp -q 85`).

**The current mark.** `OrcleIcon` is in
`apps/desktop/src/renderer/src/components/icons.tsx` (plan 119). It is a
hand-drawn orc head on Phosphor's 256 grid in `currentColor`. It has three
looks: an outline (thin, light and regular), an outline over a 20% head
(duotone), and a solid head (fill and bold). `icons.test.ts` pins that weight
contract. It renders at 16 px (`size-4`) everywhere:

| Call site | Weight |
| --- | --- |
| `workspace-nav.tsx:54`, the sidebar's Orcle row | regular, and fill when selected |
| `studio/session-panel.tsx:336`, the Studio session row | default |
| `cohost-status.tsx:100`, the status popover title | duotone |
| `cohost-pane.tsx:360` and `:995` | duotone |
| `cohost-nudge.tsx:25` | duotone |
| `stream-manager/command-cards.tsx:171` | duotone |
| `tabs/library-tab.tsx:933`, the "Orcle report" menu item | default |

**The brand images in the app today.** Only the Videorc logo
(`assets/videorc-logo.png`, 256², 95 KB) appears, in the sidebar on Windows
and Linux, About and permissions onboarding. The Orcle tab (`tabs/orcle-tab.tsx`) is
lazy-loaded (`app-shell.tsx:69`). Its `PageHeader` shows the description
only, because the toolbar holds the title. The consent dialog
`OrcleConsentDialog` (`orcle-tab.tsx:342`) has a title and a description and
no art.

**The web** (`videorcweb`). `/orcle` has a page, an OG image and a Twitter
image (`app/orcle/opengraph-image.tsx` → `renderOrcleOgImage`). Its hero uses
a screenshot (`public/blog/orcle-live-chat-moderation/hero.png`). No Orcle
logo exists there.

**Budgets.** `pnpm check:renderer-assets` measures eager JS only. No
`assetsInlineLimit` is set, so Vite's 4 KB default applies: an image under
4 KB is inlined as base64 into the chunk that imports it. That is fine,
because every planned importer sits in the lazy Orcle chunk or the shared
lazy component, never the eager graph.

### Decisions (the recommendation is taken; ⚑ = the owner may override)

1. **There are two tiers: the emblem and the glyph.** The full-colour emblem
   is used only at 24 px tall and up (32 px recommended). Below that, a new
   vector glyph is drawn *from the eye* and replaces the orc head. The raster
   is never shrunk to 16 px, because the measurement above shows it turns to
   mush.
2. **⚑ The glyph is monochrome (`currentColor`), with no red pupil.** Red
   means record, live and destructive in this design language. A red dot in
   the sidebar, beside Record, would read as "something is live". The glyph
   also has to follow the row's hover and selected tints like its Phosphor
   neighbours. The LED red lives in the emblem only.
3. **⚑ The emblem stays a raster (WebP), not a traced SVG.** The texture,
   glow and chrome *are* the identity. A trace either loses them or weighs
   more than the WebP. A vector master can come later, if the owner
   commissions one.
4. **The Videorc app logo is unchanged.** The orc-head orb stays the app
   icon, the Dock icon, About, onboarding and the Windows/Linux sidebar.
   Orcle is the eye *of* Videorc, and its mark is a distinct identity, not a
   new app logo.
5. **The emblem appears in two places only:** the Orcle tab header and the
   Orcle Live consent dialog. Those are the entry point and the moment of
   commitment. The rule "colour is information" forbids decorative imagery
   inside panes. Everything else keeps the glyph: the sidebar, the session
   row, the Stream Manager, popovers, menus and nudges.
6. **There is one file for both themes:** no tint, no CSS `filter`, and no
   per-theme variant. This was checked on both bases (see above).
7. **The export name `OrcleIcon` stays,** so all 9 call sites change with no
   edits, and the weight contract stays.

## Slices

### Phase 1: desktop (one PR)

**S1: the asset pipeline.**
- Commit the master, byte-identical, to
  `assets/brand/orcle/orcle-eye-emblem-master.png`. It sits next to
  `assets/social/`, outside every bundle.
- Derive trimmed WebPs into
  `apps/desktop/src/renderer/src/assets/orcle/`:
  - `orcle-emblem-64.webp` is 64 px tall, the 2× file for a 32 px display;
  - `orcle-emblem-112.webp` is 112 px tall, the 2× file for 56 px.
- The trim is the alpha-50% bounding box plus a 3% pad, so the glow is not
  cut hard. Keep the aspect, never square.
- Write the exact commands (`magick … -trim`, `cwebp -q 85 -resize 0 H`)
  in `assets/brand/orcle/README.md`. CI never runs them; the outputs are
  committed.
- Add `orcle-emblem.test.ts`. It reads both files and asserts:
  - the `RIFF…WEBP` header;
  - the height (64 / 112);
  - each file is ≤ 20 KB;
  - no renderer source imports the master.
- *Done when:* the test passes and the two files are under 40 KB together.

**S2: the `OrcleEmblem` component.**
- Add `components/orcle-emblem.tsx`: an `<img>` with
  `srcSet` 1×/2× and `size: 'md' | 'lg'` (32 / 56 px tall, width auto).
- Use `alt=""` by default, and accept an `alt` prop for a non-decorative use.
  Set `draggable={false}`, `decoding="async"`, `select-none` and
  `shrink-0`.
- The type offers no size under 24 px, which enforces D1.
- Test it with `renderToStaticMarkup`: the sizes, the srcset and an empty
  alt.
- *Done when:* the component tests pass.

**S3: redraw `OrcleIcon` as the eye.**
- Hand-draw it on the 256 grid, filling the width (the eye is wide, and the
  square slot loses height):
  - **The outline:** a lens or almond from about x 12 to 244 and y 64 to 196.
    The outer corners are sharp, like the emblem's points.
  - **The horn:** the emblem's signature spike. It rises up-left from the
    top-left corner to about (24, 28).
  - **The brow:** one heavy scowl plate that drops diagonally from the top
    left over the top of the iris. It is what makes the eye angry, not
    neutral.
  - **The iris:** a ring (r ≈ 40) slightly right of centre, with a pupil
    dot (r ≈ 12).
  - **The cyber half:** one plate seam on the right half. Rivets and cracks
    are dropped, because they cannot survive 16 px.
- **Keep the weight contract:**
  - thin, light and regular draw the outline at Phosphor's 16-unit stroke;
  - duotone draws the outline over a 20% fill;
  - fill and bold draw a solid eye with the iris ring knocked out and a solid
    pupil.
- Make it pixel-fit at 16 px: key edges on 16-unit boundaries, and the pupil
  never thinner than 1 device px.
- Rewrite the doc comment in `icons.tsx` (no more "the app logo's orc head")
  and the two `icons.tsx` section comments that point to it.
- Update `icons.test.ts`:
  - keep the weight assertions;
  - add an assertion that the markup carries no colour literal, only
    `currentColor` (D2).
- **The proof sheet:** a scratch script (not committed) renders the glyph at
  12, 16, 20, 24 and 32 px, in every weight, on both bases, next to the
  old head and the Phosphor neighbours (`StudioIcon`, `SourcesIcon`). Attach
  the PNG to the PR.
- *Done when:* the tests pass and the proof sheet reads as "the Orcle eye" at
  16 px in regular and fill. Get a second opinion with fresh eyes if unsure.

**S4: place the emblem (D5).**
- **The Orcle tab header.** Give `PageHeader` (`components/page.tsx`) an
  optional `media?: ReactNode` slot before the description. The 9 other
  callers stay unchanged, because the slot is absent. Pass `<OrcleEmblem
  size="md" />`. The row is `items-center` and the description stays 12 px
  muted.
- **The consent dialog** (`OrcleConsentDialog`). Put `<OrcleEmblem size="lg"
  />` above the `DialogTitle`, mirroring how permissions onboarding leads with
  the Videorc logo (`size-14`).
- No emblem anywhere else. The glyph swap in S3 already covers the
  sidebar, the Stream Manager and the menus.
- *Done when:* `orcle-tab.test.ts` asserts that both placements render the
  emblem. The by-eye check below shows nothing clipped or misaligned at the
  minimum window width.

**S5: docs.**
- In `.claude/skills/videorc-design/SKILL.md`, add an "Orcle mark"
  paragraph:
  - the emblem appears only at 24 px tall and up, untinted, in the tab header
    and the consent dialog;
  - the glyph is used everywhere else, in `currentColor`, with no red;
  - the LED red appears in the emblem only.
- Add the plan 149 entry to `plans/README.md`.
- *Done when:* the diff is reviewed.

### Phase 2: web (videorcweb, separate PR, ⚑ after the owner's by-eye check of Phase 1)

**S6: the `/orcle` page and its social cards.**
- Copy a 256 px and a 512 px WebP or PNG into `public/brand/`.
- Put the emblem above the `/orcle` hero heading at about 96 px. The
  screenshot hero stays below it.
- Lead `renderOrcleOgImage` with the emblem on the existing card. `next/og`
  needs PNG or JPEG: embed it via `fetch(new URL(…, import.meta.url))`, not
  WebP.
- *Done when:* `pnpm typecheck`, `pnpm test` (`tests/orcle.test.ts`) and
  `pnpm lint` pass, and the OG route renders locally.

## Edge cases

- **Reduced transparency or increased contrast:** the emblem is opaque art
  with its own keyline, so nothing changes. The glyph follows the text tiers
  like its neighbours.
- **Windows and Linux:** they use the same renderer files, with nothing
  platform-specific. The Windows sidebar still leads with the *Videorc* logo
  (D4).
- **HiDPI over 2×:** the 2× file is enough. The 112 px file at 56 px is the
  largest use.
- **A broken image** (it should never happen with bundled files): `alt=""`
  keeps the layout quiet, and the header's text still carries the meaning.

## Out of scope

- The Videorc app icon, the Dock, the DMG, the tray and About (D4).
- Any Orcle mark burned into the stream (overlays, the highlight card).
- Orcle animation (for example a pulsing pupil while listening). If the owner
  wants one later, it is a follow-up plan, and the pulse must not be red (D2).
- A traced vector master (D3).

## Verification gates

**Desktop:**
- `pnpm typecheck`, `pnpm lint` and `pnpm format:check`;
- `pnpm --filter @videorc/desktop test` (icons, the emblem and the Orcle
  tab);
- `pnpm build`, then `pnpm check:renderer-assets`, which must show no eager
  growth beyond noise;
- `pnpm probe:comments-window`, because the Stream Manager's Orcle pane and
  status show the glyph and it must not overflow from 320 px to 1280 px.
- No Rust, recording or native-preview gates: nothing in those paths changes.

**By eye (`run` skill)**, in dark and light:
- the sidebar's Orcle row, unselected (regular) and selected (fill);
- the Studio session row;
- the Stream Manager's Orcle pane and the status popover;
- the Library's "Orcle report" menu item;
- the Orcle tab header and the consent dialog.

**Web:** `pnpm typecheck`, `pnpm test` and `pnpm lint`.

## Owner actions

1. Confirm the rights to the emblem image: who made it and whether commercial
   use as a product mark is cleared.
2. ⚑ D2 (no red in the glyph) and D3 (a raster emblem). Silence means the
   recommendation.
3. Sign off by eye on the S3 proof sheet and the S4 placements before Phase 2.

## Handoff (cold start)

- **Goal:** the Orcle eye replaces the orc-head `OrcleIcon`, in two tiers. The
  emblem is a full-colour WebP shown at 32 or 56 px, in the Orcle tab header
  and the consent dialog. The glyph is a monochrome vector eye at 16 px,
  everywhere else.
- **Source:** `~/Downloads/Cybernetic Orc Eye Emblem.png`. Copy it in at S1;
  do not rely on Downloads afterwards.
- **Files:**
  - `components/icons.tsx` and `icons.test.ts`;
  - the new `components/orcle-emblem.tsx`;
  - `components/page.tsx`;
  - `components/tabs/orcle-tab.tsx`;
  - `assets/brand/orcle/`, and `src/renderer/src/assets/orcle/`;
  - the design skill and `plans/README.md`.
- **Order:** S1 → S2 → S3 → S4 → S5, and then the gates. S6 runs only after
  the owner's sign-off.
- **Blockers:** none technical. The owner owes the rights confirmation and the
  by-eye sign-off.
