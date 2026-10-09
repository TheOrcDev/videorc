# page-pet

Videorc's living Golem (plan 168) adopts the pet pack format of
[page-pet](https://github.com/gvastethecreator/page-pet-skill) and ports
parts of its runtime and build scripts. Read at commit `0b6a0ef`.

No page-pet art is bundled with Videorc or used in its tests; packs a user
makes with page-pet can be imported. page-pet vendors GSAP under the GSAP
Standard No Charge License; Videorc does not ship GSAP. The easing formulas
the motion model needs are reimplemented from their definitions.

## What was ported, and where

| page-pet source                                                                                                                                                                                                                                       | Videorc                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime/manifest.js`: `validateManifest`, `validateSprite`, `validateImages`, `sheetNames`, `nearestGaze`                                                                                                                                            | `crates/videorc-backend/src/golem_pet.rs`, `apps/desktop/src/shared/golem-pet.ts`, `apps/desktop/src/renderer/src/lib/golem-pet-player.ts` |
| `playground/app.js` import guards: 32 MB per file, 128 MB per pack, the per-cell transparency probe                                                                                                                                                   | `golem_pet.rs`, `shared/golem-pet.ts`, `apps/desktop/src/main/golem-assets.ts`                                                             |
| `runtime/motion.js` `MascotMotion`: the spring, the reaction envelopes and pose table, the clamps and area-preserving squash                                                                                                                          | `crates/videorc-backend/src/golem_motion.rs`, `apps/desktop/src/shared/golem-motion.ts`                                                    |
| `runtime/page-pet.js`: pointer tracking (dead zone, radius, turn nudge), `react`, `pose`, `unlock`, `center`, the tick (reaction expiry, blink on the neutral cell, sleep), click reactions, visibility and offscreen pausing, default motion options | `apps/desktop/src/renderer/src/lib/golem-pet-player.ts`, `golem_motion.rs`, `golem-motion.ts`                                              |
| `scripts/prepare_layout.py`: adaptive alpha-gutter cuts                                                                                                                                                                                               | `crates/videorc-backend/src/golem_pet_build/cut.rs`                                                                                        |
| `scripts/isolate_strip.py`: connected-component isolation (ownership rule changed)                                                                                                                                                                    | `golem_pet_build/isolate.rs`                                                                                                               |
| `scripts/build_pack.py`: body metrics, foot anchor, scale policies, margin and drift gates, single-atlas packing, manifest, report and provenance                                                                                                     | `golem_pet_build/register.rs`, `pack.rs`, `report.rs`, `mod.rs`                                                                            |
| `scripts/review_gaze.py`: rejecting duplicate cells by pixel hash                                                                                                                                                                                     | `golem_pet_build/mod.rs`                                                                                                                   |

## Licence

```
MIT License

Copyright (c) 2026 Cristian

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
