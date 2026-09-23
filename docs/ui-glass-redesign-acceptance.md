# UI Glass Redesign — Acceptance (Slice 11)

> **Superseded 2026-09-23 (plan 050).** Real macOS vibrancy works on this
> stack. Every window now sits on an `under-window` material, and the
> blurred-wallpaper underlay is retired. See
> `docs/acceptance/2026-09-23-real-glass-calibration.md` and `pnpm probe:ui-glass`.

Executed 2026-06-12 against [ui-glass-redesign-slices.md](./ui-glass-redesign-slices.md). Eleven slices, one commit each, on `main` from `192f48f5` (slice 1) through `440ee3a6` (slice 10).

## Gates

- `pnpm typecheck`, `pnpm exec vitest run` (78/78), eslint, `pnpm format:check`: green on every slice and at acceptance.
- `cargo test -p videorc-backend`: green (backend untouched by the redesign).

## Performance vs pre-migration baseline (same probe, same synthetic workload)

| Metric                                            | Baseline (pre-slice)  | Acceptance             | Verdict   |
| ------------------------------------------------- | --------------------- | ---------------------- | --------- |
| Renderer CPU                                      | 17.8%                 | 10.5%                  | better    |
| Main CPU                                          | 2.3%                  | 2.2%                   | unchanged |
| GPU process CPU                                   | 0.9%                  | 0.9%                   | unchanged |
| Presents                                          | ≈62/s, native-surface | 62.0/s, `probe PASSED` | unchanged |
| Renderer allocator growth (100s, no-preview mode) | ≈137 MB               | 120.9 MB               | not worse |

The glass theme costs nothing measurable. (The renderer allocator growth is the pre-existing leak under separate investigation — unchanged by the redesign.)

## Visual evidence

`scripts/ui-theme-screens.mjs` captured all nine tabs (studio, sources, layouts, live, recording, library, ai, diagnostics, settings) in BOTH themes — 18/18 CDP captures — reviewed against the reference image and the skill's token columns. Highlights: streaming destinations render the exact reference row anatomy (vivid platform tiles, inline context, right meta, switch); studio runs glass sections with the Space key chip on Record; the shell carries the global footer action bar with ⌘K/⌘P chips.

## Deferred items (tracked, not blocking)

1. **True under-window vibrancy is opt-in** (`VIDEORC_GLASS_VIBRANCY=1`). Cause: opening a dialog/palette live on a vibrancy window halts renderer frame production; reproduces on pre-redesign commits. Until fixed, the shell uses the skill's solid-fallback glass.
2. **Command palette restyle is unverifiable** until the (likely pre-existing) palette-open rendering wedge is fixed — its `Command` components are restyled and the wedge is tracked as its own task.
3. **Perceptual smoothness pass is the owner's call** per the project rule (metrics are blind to judder): after restarting `pnpm dev`, watch the live preview while recording for a minute and confirm by eye.
