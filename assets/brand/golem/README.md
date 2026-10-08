# Golem emblem and default avatar

The Golem feature's mark (plan 164, owner-supplied 2026-10-08).
`golem-master.png` is the original artwork, byte-identical: 1312 × 1199 RGBA
on a transparent background. It is outside every bundle; the app ships
trimmed exports.

- **`OrcleIcon`** (`apps/desktop/src/renderer/src/components/icons.tsx`)
  is the 64 px export at icon size (16 px slots), wrapped in an `<svg>`.
- **`OrcleEmblem`** shows it larger, at 32 and 56 px tall.
- **The default avatar pack** (`assets/golem/default/idle.webp`) is the
  640 px export: what a fresh install's Golem looks like on stream.

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
| `default/idle.webp`     | 710 × 640 | the Golem overlay and the tab tiles |

Each emblem file is the 2× asset for its display height. CI never runs
these commands: the outputs are committed, and `orcle-emblem.test.ts` pins
their format, heights and byte caps.
