# Golem emblem and default avatar

The Golem feature's mark (plan 164, owner-supplied 2026-10-08).
`golem-master.png` is the original artwork, byte-identical: 1312 × 1199 RGBA
on a transparent background. It is outside every bundle; the app ships
trimmed exports.

- **`OrcleIcon`** (`apps/desktop/src/renderer/src/components/icons.tsx`)
  is the 64 px export at icon size (16 px slots), wrapped in an `<svg>`.
- **`OrcleEmblem`** shows it larger, at 32 and 56 px tall.
- **The default avatar pack** (`assets/golem/default/*.webp`): `idle` is
  the 640 px export of `golem-master.png`; `talk`, `laugh` and `think` come
  from `golem-talk-master.png`, `golem-laugh-master.png` and
  `golem-think-master.png`, 1024 × 1024 image edits of the idle art made
  with `openai/gpt-image-2.5-sunburst` through the Vercel AI Gateway on
  2026-10-09 (prompt: keep the exact character, full body, same size and
  baseline; change only the face and arms).

## Exports

The trim drops fully transparent borders and adds a 2% pad: `1332 × 1200`.

```sh
magick assets/brand/golem/golem-master.png \
  -background none -trim +repage -bordercolor none -border 2% /tmp/golem-trim.png

for height in 64 112; do
  cwebp -quiet -q 85 -alpha_q 100 -resize 0 "$height" /tmp/golem-trim.png \
    -o "apps/desktop/src/renderer/src/assets/golem/golem-emblem-$height.webp"
done
cwebp -quiet -q 90 -alpha_q 100 -resize 0 640 /tmp/golem-trim.png \
  -o apps/desktop/src/renderer/src/assets/golem/default/idle.webp
```

| File                    | Size      | Shown at                            |
| ----------------------- | --------- | ----------------------------------- |
| `golem-emblem-64.webp`  | 71 × 64   | icons, and 32 px tall (`size="md"`) |
| `golem-emblem-112.webp` | 124 × 112 | 56 px tall (`size="lg"`)            |
| `default/idle.webp`     | 711 × 640 | the Golem overlay and the tab tiles |
| `default/talk.webp`     | 669 × 643 | the same, while the Golem talks     |
| `default/laugh.webp`    | 580 × 658 | the same, while it laughs           |
| `default/think.webp`    | 553 × 646 | the same, while it thinks           |

The state masters were exported at the idle image's scale (80.2 %, which
makes the golem the same height as in `idle.webp`), after clearing the
model's faint background haze (alpha below 6 %):

```sh
for state in talk laugh think; do
  magick "assets/brand/golem/golem-$state-master.png" \
    -channel A -fx "u<0.06?0:u" +channel -resize 80.2% \
    -background none -trim +repage -bordercolor none -border 2% "/tmp/$state.png"
  cwebp -quiet -q 90 -alpha_q 100 "/tmp/$state.png" \
    -o "apps/desktop/src/renderer/src/assets/golem/default/$state.webp"
done
```

Each emblem file is the 2× asset for its display height. CI never runs
these commands: the outputs are committed, and `orcle-emblem.test.ts` pins
their format, heights and byte caps.
