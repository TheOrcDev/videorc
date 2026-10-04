# Orcle eye emblem

Orcle's official mark (plan 149). `orcle-eye-emblem-master.png` is the
original artwork, byte-identical: 1254 × 1254 RGBA on a transparent
background. It is outside every bundle; the app ships trimmed WebP exports.

The mark has two tiers:

- **The emblem**, this artwork, in full colour at 24 px tall and up
  (`OrcleEmblem` in the desktop renderer). The LED-red iris lives here only.
- **The glyph**, a monochrome vector eye drawn from it for 16 px slots
  (`OrcleIcon` in `apps/desktop/src/renderer/src/components/icons.tsx`).

## Exports

The trim is the opaque eye (alpha above 50%, 1194 × 808 at +33+193) plus a
3% pad (36 px), clamped to the canvas: `1254x880+0+157`. Each crop edge is
fully transparent, so no glow is cut hard.

```sh
magick assets/brand/orcle/orcle-eye-emblem-master.png \
  -crop 1254x880+0+157 +repage /tmp/orcle-emblem-trim.png

for height in 64 112; do
  cwebp -quiet -q 85 -alpha_q 100 -resize 0 "$height" /tmp/orcle-emblem-trim.png \
    -o "apps/desktop/src/renderer/src/assets/orcle/orcle-emblem-$height.webp"
done
```

| File | Size | Shown at |
| --- | --- | --- |
| `orcle-emblem-64.webp` | 92 × 64 | 32 px tall (`size="md"`) |
| `orcle-emblem-112.webp` | 160 × 112 | 56 px tall (`size="lg"`) |

Each file is the 2× asset for its display height. CI never runs these
commands: the outputs are committed, and `orcle-emblem.test.ts` pins their
format, heights and byte caps.
