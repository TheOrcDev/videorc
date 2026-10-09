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
makes the buddy the same height as in `idle.webp`), after clearing the
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

Videorc's official Buddy library is the Buddy above plus four characters
drawn in the same house look: Golmar the Orc, Nib the Goblin, Captain
Barnacle the Pirate and Bolt the Robot. Their names, taglines,
personalities and the descriptions they were drawn from live in
`protocol-fixtures/buddy-official-catalog.json`; the website and the app
must match that file.

`official/<slug>/<state>-master.png` are the 1024 × 1024 model outputs
(idle, talk, laugh, think), made with `openai/gpt-image-2.5-sunburst`
through the Vercel AI Gateway on 2026-10-09 by `pnpm buddy:official`
(`scripts/buddy-official-generate.mjs`): the idle is an image edit of the
style anchor (the Buddy master trimmed onto a 1024 px transparent canvas,
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
makes its idle character 615 px tall, the buddy's height inside the
640 px `default/idle.webp` (before the pad), so every
official character stands at the Buddy's size and its four poses match. The website serves the same WebP files
from `public/buddy/official/<slug>/`, and the Buddy's official files there
are copies of `default/*.webp`.
