# Background tile pictures (GPUI app)

The Orc on the camera Background tiles, on the popover's "What viewers see"
until a camera frame arrives, and on the Studio Camera row's 16 px trigger
picture (`apps/videorc/src/screens/studio/background.rs`, `orc_art`). They are
built into the binary with `include_bytes!`.

Owner's own character, from orc.pictures, Videorc category:
`public/gifs/videorc/orc-smile.jpg` (640×640). No image generation.

- `orc.webp` and `orc-room.webp`: byte copies of the Electron app's
  (`apps/desktop/src/renderer/src/assets/camera-background/`, whose README has
  how they were made): 480×300 (16:10), the Orc cut out onto transparency, and
  his studio with the Orc filled in from the room around him. Change them
  there first, then copy them here.
- `orc-room-slight-blur.webp` and `orc-room-strong-blur.webp`: 480×300, the
  room blurred ahead of time, because GPUI's `img` has no blur filter. Electron
  blurs the room at render with an SVG `feGaussianBlur` of 2.2 (Slight) and 5.5
  (Strong) in a 160-wide picture, and makes the result opaque again. At 480
  wide that is a sigma of 6.6 and 16.5, with the edge pixels repeated so the
  edges keep their own colours:

  ```sh
  magick orc-room.webp -alpha off -virtual-pixel Edge -gaussian-blur 0x6.6 slight.png
  magick orc-room.webp -alpha off -virtual-pixel Edge -gaussian-blur 0x16.5 strong.png
  cwebp -m 6 -sharp_yuv -q 72 slight.png -o orc-room-slight-blur.webp
  cwebp -m 6 -sharp_yuv -q 72 strong.png -o orc-room-strong-blur.webp
  ```

  Make them again whenever `orc-room.webp` changes.
