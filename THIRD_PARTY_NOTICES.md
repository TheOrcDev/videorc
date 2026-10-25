# Third-party notices

Videorc is licensed under the GNU Affero General Public License v3.0 (see
`LICENSE`). This file lists third-party work included in Videorc under other
terms.

## React Bits

The ten live backgrounds (Silk, Side Rays, Plasma Wave, Liquid Chrome, Line
Waves, Beams, Color Bends, Dither, Ferrofluid and Ghost Fibers) are ported
from React Bits by David Haz, https://reactbits.dev and
https://github.com/DavidHDev/react-bits.

- Files:
  - `crates/videorc-backend/src/live_background/glsl/` and its Metal and
    D3D11 ports;
  - `apps/desktop/src/shared/live-background-webgl.js`;
  - the posters and thumbnails named `live-*.webp`.
- Licence: MIT + Commons Clause License Condition v1.0, copyright (c) 2026
  David Haz.
- Permission: the author gave Videorc permission to include the ported
  shaders, 2026-10-24.
- Videorc ships them as part of the application only. It does not sell,
  sublicense or redistribute them on their own, as a pack, or as a port of
  React Bits' Background Studio.

```
MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software as part of
an application, website, or product, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

Commons Clause Restriction: You may use this Software, including for any
commercial purpose, so long as you do not sell, sublicense, or redistribute
the components themselves - whether alone, in a bundle, or as a ported
version.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
