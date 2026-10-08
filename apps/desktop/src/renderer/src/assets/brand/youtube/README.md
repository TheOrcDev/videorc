# YouTube icon (official)

`youtube-icon-red.svg` is the official full-colour YouTube icon, exactly as
YouTube publishes it. It is used wherever Videorc shows that something comes
from YouTube (plan 165, the reply to Google's YouTube API Services ToS
Violations Report V.1, policy III.F.2a).

## Source

| Item           | Value                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Brand page     | https://brand.youtube/youtube-icon (where YouTube's brand-resources page redirects)             |
| Download       | https://www.gstatic.com/marketing-cms/78/29/3e68a1414bb28d0b7e47b44c3c91/youtube-icon.zip       |
| Downloaded     | 2026-10-08                                                                                      |
| Zip sha256     | `ca9b5104387e0f7afcfda3a79c910449561112f1077177dd0d64f8c72f56e476`                              |
| Source file    | `YouTube_Icon/Digital/01 Red/yt_icon_red_digital.ai` (Illustrator 29.0, 2025-04-06)             |
| Source sha256  | `b5958b5f28b494b9e3e3962bdf5619c69c6733e409cc23845c6910af84d80c22`                              |
| Shipped file   | `youtube-icon-red.svg`                                                                          |
| Shipped sha256 | `2d05d7fc1137309be4f08894ad81e282ea0d71f2e7f822c4520c20a1745f60c7` (checked by `icons.test.ts`) |

YouTube ships the icon as AI, EPS, PDF and PNG, with no SVG. The SVG is a
lossless vector conversion of the official `.ai` file (a PDF-compatible
file), made with poppler 25.01.0:

```sh
pdftocairo -svg "YouTube_Icon/Digital/01 Red/yt_icon_red_digital.ai" youtube-icon-red.svg
```

The output is the official artwork and nothing else:

- One red path, `rgb(100%, 0%, 19.999695%)`, which is YouTube Red `#FF0033`.
- One white path, the play triangle.
- The artboard is 602.187 × 515.868, which includes YouTube's clear space.

**Never edit this file by hand.** To update it, convert a fresh download the
same way and update the hashes above.

## Rules (YouTube Branding Guidelines and brand.youtube)

- **Unchanged.** Keep the shape and colour. Never tint it, add a stroke or
  shadow, rotate, squash or stretch it. `YoutubeIcon` in
  `components/icons.tsx` draws the file through an `<image>`, so CSS colour
  (`currentColor`, hover recolours) can never reach it.
- **At least 20px tall.** The visible mark (the red rounded rectangle) is
  never shorter than 20px (20dp). `YoutubeIcon` crops its `viewBox` to the
  mark's own bounds (x 102.6875–498.6875, y 119.167969–396.570312) so its box
  is the mark, and it clamps any smaller size up to 20px (about 29 × 20).
- **Solid background, clear space.** Place it on a single solid surface,
  never over a photo or avatar. Keep other elements at least the triangle's
  width away (8px / `gap-2` at 20px).
- **Too small to fit?** Write "YouTube" as text instead. Never show a smaller
  mark.
