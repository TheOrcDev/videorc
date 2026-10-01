# audiocn in Videorc

[audiocn](https://audiocn.dev) (`TheOrcDev/audiocn`, local checkout
`~/projects/audiocn`) is the owner's shadcn registry of audio components.
Videorc vendors part of it with the shadcn CLI: `@audiocn` is a registry in
`apps/desktop/components.json`. The decision record, with what Videorc does not
use and why, is `plans/092-audiocn-audio-components.md`.

## What is installed

| audiocn item                                                                                    | Files                       | Videorc home                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `core`                                                                                          | `lib/audio/*.ts` (11 files) | Used by every item below                                                      |
| `use-frame-source`, `use-clip-hold`, `use-audio-config`, `use-visibility`, `use-reduced-motion` | `hooks/`                    | Dependencies of the components (`use-reduced-motion` also serves the sidebar) |
| `level-meter` with `db-scale`, `db-readout`, `clip-indicator`                                   | `components/ui/`            | Studio Audio mixer strips                                                     |
| `channel-strip`, `mixer`                                                                        | `components/ui/`            | Studio Audio mixer                                                            |
| `bar-visualizer`                                                                                | `components/ui/`            | Session mic sliver                                                            |
| `live-waveform`                                                                                 | `components/ui/`            | Sources mic preview                                                           |

Renderer paths are relative to `apps/desktop/src/renderer/src/`.

Installed from: audiocn `221100c` (branch `fix/videorc-adoption`, the plan
092 U1 fixes), served from a local build of that commit. Once that branch is
merged, audiocn.dev serves the same files.

## Rules

- **Never use audiocn's Web Audio hooks or blocks** (`useMicrophone`, `useAudioAnalyser`, `useAudioDevices`, `useSystemAudio`, `useWebAudioMixer`, the six blocks). The backend is the capture authority. The renderer's only microphone stream is the visual one owned by `StudioMicVisualProvider`, which opens only after an exact `granted` status.
- **Base UI stays inside audiocn files.** `@base-ui/react` may only be imported by the files in `AUDIOCN_BASE_UI_FILES` (`eslint.config.mjs`). Videorc's own UI uses Radix.
- **Do not edit vendored files.** Fix the problem in audiocn, then re-install. Local patches: none.
- **Tokens are Videorc tokens.** The `audiocn` block in `styles.css` points the six meter and channel tokens at `--foreground`, `--warning`, `--destructive` and `--info`. Never keep the CSS the CLI writes (raw colours, and self-referencing lines in `@theme inline`); `audiocn-adoption.test.ts` fails if it comes back.

## Feeding the components

The components never open a device. Videorc's own sources feed them through
adapters that live outside the eager bundle:

- `lib/mic-frame-sources.ts` turns the visual mic pipeline into audiocn frame sources: `createMicMeterSource` (peak and RMS with the configured mic gain added, silence while muted) and `createMicVisualSource` (bands and level history, raw).
- `hooks/use-studio-mic-sources.ts` returns one stable source per pipeline. Only lazy chunks (the Studio dashboard, the Studio tab, Sources) import it.
- Backend levels (`diagnostics.stats`, 1 Hz, already post-gain) go in as plain values: `LevelMeter peakDb`, `DbReadout value`, `ClipIndicator clipping`, with `vu` ballistics so one step a second glides.

## Updating

1. From `apps/desktop`: `pnpm dlx shadcn@4.21.1 add @audiocn/level-meter @audiocn/mixer @audiocn/bar-visualizer @audiocn/live-waveform`.
2. Answer the prompts: `use-reduced-motion.ts` **Yes**, `badge.tsx` **No** (it would replace the glass-chip badge), `bar-visualizer.tsx` and `live-waveform.tsx` **Yes**. Any other prompt: stop and look with `--dry-run --diff`.
3. Undo the CLI's CSS (`git checkout -- apps/desktop/src/renderer/src/styles.css`), remove the `cn` package it adds to `apps/desktop/package.json`, then `pnpm install`.
4. Run `pnpm exec prettier --write` on the changed files and review the diff.
5. Run `pnpm typecheck`, `pnpm lint` (stage first: the em-dash gate reads `git ls-files`), `pnpm format:check`, `pnpm --filter @videorc/desktop test`, `pnpm build && pnpm check:renderer-assets`.
6. Record the audiocn commit above.

## Not adopted

`parameter-slider` (Base UI Slider and NumberField, about 25 KB gzip, for what
`PowerSlider` already does), `audio-device-select` (Base-only Select API;
`SourceSelect` stays the one picker), `fader` (only if Gain moves into the
mixer), `channel-toggle`, `knob`, `pan-control`, `volume-control`,
`audio-player`, `track-list`, `sound-pad`, `waveform`, `spectrum`, the smooth
and electric visualizers, every block, and the Web Audio hooks. Reasons, item
by item: plan 092.
