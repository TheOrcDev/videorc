# Background tile pictures

The Orc on the camera Background tiles and on the Studio Camera row's 16 px
trigger picture (`camera-background-orc-art.tsx`). Owner's
own character, from orc.pictures, Videorc category: `public/gifs/videorc/orc-smile.jpg`
(640×640). No image generation.

- `orc.webp`: 480×300 (16:10, the tile at 2x and up), the Orc cut out onto
  transparency. Mask from macOS Vision's foreground instance mask
  (`VNGenerateForegroundInstanceMaskRequest`). The source frame cuts his shoulders, so
  each side is mirrored out 192 source pixels under a sloping shoulder line and
  shaded toward the edge; 40 px of headroom above.
- `orc-room.webp`: 480×300, his studio from the same picture with the Orc filled in
  from the room around him (alpha-weighted push-pull), so a blurred room never
  smears a second Orc behind the sharp one. The tiles blur it at render.

Encoded with `cwebp -m 6 -sharp_yuv` (`-q 78 -alpha_q 85` for the Orc, `-q 72` for
the room). Loaded with `?no-inline` from a lazy chunk only (the picker's, and the trigger's
thumbnail through `React.lazy`), never the launch bundle.
