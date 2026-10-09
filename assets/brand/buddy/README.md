# Buddy emblem and default avatar

The Buddy feature's mark (plan 164, owner-supplied 2026-10-08).
`golem-master.png` is the original artwork, byte-identical: 1312 × 1199 RGBA
on a transparent background. It is outside every bundle; the app ships
trimmed exports.

- **`BuddyIcon`** (`apps/desktop/src/renderer/src/components/icons.tsx`)
  is the 64 px export at icon size (16 px slots), wrapped in an `<svg>`.
- **`BuddyEmblem`** shows it larger, at 32 and 56 px tall.
- **The default avatar pack** (`assets/buddy/default/*.webp`): `idle` is
  the 640 px export of `golem-master.png`; `talk`, `laugh` and `think` come
  from `golem-talk-master.png`, `golem-laugh-master.png` and
  `golem-think-master.png`, 1024 × 1024 image edits of the idle art made
  with `openai/gpt-image-2.5-sunburst` through the Vercel AI Gateway on
  2026-10-09 (prompt: keep the exact character, full body, same size and
  baseline; change only the face and arms).

## Exports

The trim drops fully transparent borders and adds a 2% pad: `1332 × 1200`.

```sh
magick assets/brand/buddy/golem-master.png \
  -background none -trim +repage -bordercolor none -border 2% /tmp/buddy-trim.png

for height in 64 112; do
  cwebp -quiet -q 85 -alpha_q 100 -resize 0 "$height" /tmp/buddy-trim.png \
    -o "apps/desktop/src/renderer/src/assets/buddy/buddy-emblem-$height.webp"
done
cwebp -quiet -q 90 -alpha_q 100 -resize 0 640 /tmp/buddy-trim.png \
  -o apps/desktop/src/renderer/src/assets/buddy/default/idle.webp
```

| File                    | Size      | Shown at                            |
| ----------------------- | --------- | ----------------------------------- |
| `buddy-emblem-64.webp`  | 71 × 64   | icons, and 32 px tall (`size="md"`) |
| `buddy-emblem-112.webp` | 124 × 112 | 56 px tall (`size="lg"`)            |
| `default/idle.webp`     | 711 × 640 | the Buddy overlay and the tab tiles |
| `default/talk.webp`     | 669 × 643 | the same, while the Buddy talks     |
| `default/laugh.webp`    | 580 × 658 | the same, while it laughs           |
| `default/think.webp`    | 553 × 646 | the same, while it thinks           |

The state masters were exported at the idle image's scale (80.2 %, which
makes the golem the same height as in `idle.webp`), after clearing the
model's faint background haze (alpha below 6 %):

```sh
for state in talk laugh think; do
  magick "assets/brand/buddy/golem-$state-master.png" \
    -channel A -fx "u<0.06?0:u" +channel -resize 80.2% \
    -background none -trim +repage -bordercolor none -border 2% "/tmp/$state.png"
  cwebp -quiet -q 90 -alpha_q 100 "/tmp/$state.png" \
    -o "apps/desktop/src/renderer/src/assets/buddy/default/$state.webp"
done
```

Each emblem file is the 2× asset for its display height. CI never runs
these commands: the outputs are committed, and `buddy-emblem.test.ts` pins
their format, heights and byte caps.

## Official characters (plan 170)

Videorc's official Buddy library is the stone golem above (Buddy the Golem)
plus four characters drawn in the same house look: Golmar the Orc, Nib the Goblin, Captain
Barnacle the Pirate and Bolt the Robot. Their names, taglines,
personalities and the descriptions they were drawn from live in
`protocol-fixtures/buddy-official-catalog.json`; the website and the app
must match that file.

`official/<slug>/<state>-master.png` are the 1024 × 1024 model outputs
(idle, talk, laugh, think), made with `openai/gpt-image-2.5-sunburst`
through the Vercel AI Gateway on 2026-10-09 by `pnpm buddy:official`
(`scripts/buddy-official-generate.mjs`): the idle is an image edit of the
style anchor (the golem master trimmed onto a 1024 px transparent canvas,
"art style only, not the character") with the plan 169 house-look prompt,
and talk, laugh and think are edits of that idle with the same state
directions as the default Buddy. The owner reviews every set before it
ships; to redo one pose:

```sh
pnpm buddy:official --slug orc --states laugh \
  --anchor ../videorc-web/lib/ai/buddy-look/style-reference.png
```

The script exports each master to
`apps/desktop/src/renderer/src/assets/buddy/official/<slug>/<state>.webp`
like the default states (haze below 6 % alpha cleared, trimmed, 2 % pad,
`cwebp -q 90 -alpha_q 100`), with one scale per character: the factor that
makes its idle character 615 px tall, the golem's height inside the
640 px `default/idle.webp` (before the pad), so every
official character stands at the golem's size and its four poses match. The website serves the same WebP files
from `public/buddy/official/<slug>/`, and Buddy the Golem's official files there
are copies of `default/*.webp`.

## Alive packs (plan 172)

All five official Buddies are alive: each has a page-pet pack (40 frames of
640 px: 25 gaze cells, 12 reactions, `talk-a`, `talk-b`, `wave`, one
3200 × 5120 `mascot.webp`, `manifest.json`, `buddy.json`). Buddy the Golem's
ships in the app as `bundled:buddy` (`apps/desktop/resources/buddy/buddy/`);
Golmar, Nib, Captain Barnacle and Bolt (`official:<slug>`) download from
videorc.com (`public/buddy/official/<slug>/alive/1/` in videorc-web) the
first time they are used. The official catalog's `alive` block pins every
file's size and SHA-256.

They were made on 2026-10-09 by `pnpm buddy:alive`
(`scripts/buddy-alive-generate.mjs`, pure parts and tests in
`scripts/lib/buddy-alive.mjs`), which runs the in-app creator's pipeline
headless, with the creator's own prompt words (a checked copy of videorc-web
`lib/ai/cohost-pet-prompts.ts`):

1. The reference: the official idle master (`golem-master.png`, or
   `official/<slug>/idle-master.png` with its faint haze below 6 % alpha
   cleared) trimmed onto a transparent 1024 px canvas, like the style anchor.
2. Identity notes from `openai/gpt-5.5` (the web's identity request: strict
   JSON schema, low reasoning effort, 2048 output tokens).
3. A pilot, then eight sheets, each an image edit of the reference with
   `openai/gpt-image-2.5-sunburst` through the Vercel AI Gateway: five gaze
   strips (3072 × 1024), two reaction sheets (2304 × 1536, or 2048 × 2048
   when the character is narrower than 0.9 of its height) and the extras
   strip (2304 × 1024).
4. The app's builder through `cargo run -p videorc-backend --example
   buddy_pack`, which cuts, isolates, registers and packs, then loads the
   pack with the app's own loader.
5. Review files: a contact sheet per gaze row and reaction sheet with each
   cell's intended pose, the 25 heads at atlas resolution, the gaze grid and
   an animated WebP (gaze sweep, reactions, talk, wave).

```sh
pnpm buddy:alive --slug orc --web ../videorc-web           # the whole run
pnpm buddy:alive --slug orc --web ../videorc-web --sheets gaze-up2,extras  # redo rows
pnpm buddy:alive --slug orc --build-only --compare         # D3 side by side
pnpm buddy:alive --slug orc --build-only --ship q92        # the shipped copy
```

Sources (the reference and every pilot and sheet version, never
overwritten) live outside the repo in `~/videorc-assets/buddy-alive/<slug>/`
(`sources/`, `identity.json`, `generations.jsonl` with size, alpha, wall time
and cost per call, `build.json`); `sources/accepted.json` pins an older
version of a sheet. Nothing there is committed; each pack's
`provenance.json` records the SHA-256 of every source it was built from.

**Size** (plan 172 D3, 6 MB line): Buddy the Golem (7.12 MB lossless) and Nib
(6.22 MB) ship with lossy colour at quality 92 and lossless alpha
(1.62 MB and 1.49 MB), which looked the same as lossless side by side at
on-stream size and at twice that on the face; Golmar (5.80 MB), Captain
Barnacle (5.80 MB) and Bolt (5.17 MB) are under the line and ship lossless.
No pack needed 512 px cells.

The owner approves every gaze row and reaction sheet of every pack from the
contact sheets and the animated preview before it ships (plan 172 D6); a
rejected row is redone, never hand-edited.
