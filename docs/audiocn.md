# audiocn in Videorc

[audiocn](https://audiocn.dev) (`TheOrcDev/audiocn`, local checkout
`~/projects/audiocn`) is the owner's shadcn registry of audio components.
Videorc vendors part of it with the shadcn CLI: `@audiocn` is a registry in
`apps/desktop/components.json`. The decision records, with what Videorc does
not use and why, are `plans/092-audiocn-audio-components.md` (meters) and
`plans/093-sources-audio-mixer-on-audiocn-controls.md` (the Sources controls).
Plan 196 (`plans/196-lcd-level-meter.md`) moved every level onto the LCD
meter. Plan 173 (`plans/173-sources-tab-rewrite.md`) rebuilt the Sources page: the
controls stayed, the channel strips gave way to Sources rows.

## What is installed

| audiocn item                                                                                    | Files                       | Videorc home                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `core`                                                                                          | `lib/audio/*.ts` (11 files) | Used by every item below                                                      |
| `use-frame-source`, `use-clip-hold`, `use-audio-config`, `use-visibility`, `use-reduced-motion` | `hooks/`                    | Dependencies of the components (`use-reduced-motion` also serves the sidebar) |
| `lcd-meter` with `lcd-display`                                                                  | `components/ui/`            | Studio Microphone section and the Sources rows (`MicLevelMeter`, plan 196)    |
| `level-meter` with `db-scale`, `db-readout`, `clip-indicator`                                   | `components/ui/`            | Under `lcd-meter`, which is built on it                                       |
| `bar-visualizer`                                                                                | `components/ui/`            | Session mic sliver                                                            |
| `mixer`                                                                                         | `components/ui/`            | Sources Audio column: meter range, Cmd+Up/Down between rows (plans 093, 173)  |
| `fader`                                                                                         | `components/ui/`            | Sources: Microphone Gain, System audio and Sounds Level, Assets → Sounds      |
| `parameter-slider`                                                                              | `components/ui/`            | Sources: Microphone Sync                                                      |
| `channel-toggle`                                                                                | `components/ui/`            | Sources: Microphone Mute (`MuteToggle`)                                       |
| `sound-pad`                                                                                     | `components/ui/`            | Studio → Soundboard and the Stream Manager's Sounds popover (plan 189)        |

Renderer paths are relative to `apps/desktop/src/renderer/src/`.

Installed from:

- Plan 092 items: audiocn `d4dfc0a` (branch `fix/videorc-adoption`, the plan
  092 U1 fixes, audiocn PR #2), served from a local build of that commit.
- Plan 093 items (`channel-strip` (removed by plan 173), `mixer`, `fader`,
  `parameter-slider`, `channel-toggle`): a local registry build of audiocn main `f53bfe6` merged
  with PR #2 (`136c574`, the tree PR #2's merge produces). Every shared file
  (`lib/audio/*`, `use-audio-config`, `db-scale`) came out byte-identical to
  the plan 092 copies after Prettier.

- Plan 189 item (`sound-pad`): the shadcn CLI from audiocn.dev on
  2026-10-23. After Prettier it is byte-identical to
  `components/ui/sound-pad.tsx` at audiocn origin/main `521c03f`. Only that
  file was taken: the CLI also rewrote `kbd.tsx`, `use-frame-source.ts` and
  `lib/audio/*` (formatting, three optional history fields in `types.ts`)
  and added `lib/audio/history.ts` and `history-playback.ts`; Videorc kept
  its own copies and dropped the two new files, which the pad never imports.

- Plan 196 items (`lcd-meter`, `lcd-display`, and the `level-meter` they
  need): the shadcn CLI on 2026-10-25, `@audiocn/lcd-meter` from audiocn.dev
  (origin/main `bcc737f`), then `lcd-display.json` from a local registry
  build of audiocn PR #32 (`5ffbf9f`, the select trigger without
  `cursor-pointer`). After Prettier, `lcd-meter.tsx` and `level-meter.tsx`
  are byte-identical to `bcc737f` and `lcd-display.tsx` to `5ffbf9f`. Only
  those three files were taken: the CLI also rewrote every shared file
  (`hooks/`, `lib/audio/*`, `db-scale`, `db-readout`, `clip-indicator`) and
  added `use-audio-context.tsx`, `lib/audio/click.ts`, `history.ts` and
  `history-playback.ts`; Videorc kept its copies and dropped the new files,
  which the LCD never imports.

PR #2 merged as audiocn `d3736de` (2026-10-02). Checked against audiocn.dev
at that commit, after Prettier: every plan 093 file and every shared file is
byte-identical. Upstream is ahead of Videorc's shared copies, not adopted
yet:

- `lib/audio/types.ts` and `lib/audio/decibels.ts` each gained one leading
  doc comment; `types.ts` also gained three optional history fields.
- `lib/audio/frame-loop.ts` runs listeners in an update phase, then a paint
  phase.

Adopting them is an ordinary update (see Updating). Plan 196 adopted
audiocn #4 (`level-meter`'s `[overflow-anchor:none]` and room for a
horizontal scale) with the LCD.

## Rules

- **Never use audiocn's Web Audio hooks or blocks** (`useMicrophone`, `useAudioAnalyser`, `useAudioDevices`, `useSystemAudio`, `useWebAudioMixer`, `useSound`, the blocks, the soundboard block among them). The backend is the capture authority. The renderer's only microphone stream is the visual one owned by `StudioMicVisualProvider`, which opens only after an exact `granted` status.
- **Base UI stays inside audiocn files.** `@base-ui/react` may only be imported by the files in `AUDIOCN_BASE_UI_FILES` (`eslint.config.mjs`). Videorc's own UI uses Radix.
- **Do not edit vendored files.** Fix the problem in audiocn, then re-install. Local patches: none, except `hooks/use-reduced-motion.ts`, which carries Videorc's `smoothScrollBehavior()` (plan 174 S1.8): restore it after any `--overwrite`.
- **The LCD draws in Videorc's ink.** `LcdDisplay` keeps `variant="primary"` (`--primary`) and `appearance="auto"`; no hardware ink. Its bezel and glass are the instrument's own materials, so `lcd-display.tsx` is on the style guard's colour-literal allowlist; `audiocn-adoption.test.ts` keeps `LcdDisplay` inside `MicLevelMeter`, with no `variant` or `appearance`.
- **Tokens are Videorc tokens.** The `audiocn` block in `styles.css` points the three meter tokens (and their foregrounds) at `--foreground`, `--warning` and `--destructive`, and the channel tokens at `--warning` (mute, the muted-speaker amber), `--foreground` (solo) and `--info` (monitor); solo and monitor have no Videorc use. Never keep the CSS the CLI writes (raw colours, and self-referencing lines in `@theme inline`); `audiocn-adoption.test.ts` fails if it comes back.

- **Videorc's skin comes from outside.** Vendored files stay pristine; Videorc styles the parts it renders through `className`:

  | audiocn default                                                       | Videorc override                                                                                 |
  | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
  | Fader and ParameterSlider thumbs `bg-background ring-foreground/15`   | `bg-knob ring-knob-ring`, like every Videorc slider (`FaderThumb className`, and a `data-slot` selector on `ParameterSlider`) |
  | `ChannelToggle` `rounded-lg`                                          | `rounded-chip` (controls are 6 px)                                                               |
  | `MixerChannels` scrolls                                               | `scrollable={false}`: only `PaneBody` scrolls                                                    |
  | `SoundPad` `rounded-xl`                                               | `rounded-row` (pads are cards, 8 px); the file is in `OFF_TIER_RADIUS_ALLOWLIST`                 |

- **No control without a backend path.** Videorc has no pan, solo, monitoring or player, so `pan-control`, `SoloToggle`, `MonitorToggle` and `volume-control` stay out until the backend has something for them to drive (plan 093, D1 and D2).
- **Values are whole numbers.** The renderer rounds stored audio settings (`clampNumber` in `lib/capture.ts`), so faders step 1 dB with no Alt sub-steps.

## Feeding the components

The components never open a device. Videorc's own sources feed them through
adapters that live outside the eager bundle:

- `lib/mic-frame-sources.ts` turns the visual mic pipeline into audiocn frame sources: `createMicMeterSource` (peak and RMS with the configured mic gain added, silence while muted) and `createMicVisualSource` (bands and level history, raw).
- `hooks/use-studio-mic-sources.ts` returns one stable source per pipeline. Only lazy chunks (the Studio dashboard, the Studio tab, Sources) import it.
- `useMicrophoneMeter()` (same module) builds the microphone meter's input and state once, for the Studio Microphone section and the Sources Microphone row; `lib/mic-meter-input.ts` holds the pure choice (`micMeterInput`, `systemAudioMeterInput`) and `components/studio/mic-level-meter.tsx` draws it.
- The Studio microphone meter runs whenever Studio is open, from the backend's own `audio.levels`, about 20 a second with the configured gain applied: from the session bus during a session (which also carries System audio and the mix as written), and from the warm microphone between sessions (microphone only, no `sessionId`). `lib/backend-audio-levels.ts` keeps them outside React (eager, no dependencies); `lib/backend-level-sources.ts` turns them into meter sources and reads the -120 dBFS wire floor as silence.
- Where the backend has no standby microphone (no CoreAudio, or Keep microphone warm off), the renderer analyser drives the meter; during a session the 1 Hz `diagnostics.stats` level is the last fallback, as a plain value with `vu` ballistics so one step a second glides.

## Updating

1. From `apps/desktop`, look first: `pnpm dlx shadcn@4.21.1 add @audiocn/lcd-meter @audiocn/level-meter @audiocn/bar-visualizer @audiocn/mixer @audiocn/fader @audiocn/parameter-slider @audiocn/channel-toggle @audiocn/sound-pad --dry-run --diff`.
2. Then install. The CLI asks per colliding file and ignores piped answers, so install with `--overwrite` (`bar-visualizer.tsx` is audiocn's own; `use-reduced-motion.ts` is too, apart from Videorc's `smoothScrollBehavior`, which must survive) and restore what Videorc owns: `badge.tsx` (if an item pulls it in, the CLI's shadcn badge would replace the glass-chip badge), `kbd.tsx` (`sound-pad` pulls in shadcn's, which would replace the glass keycap) and `styles.css` (next step). Any file outside the installed list: stop and look with `--dry-run --diff`.
3. Back at the repo root (the remaining steps run there): undo the CLI's CSS (`git checkout -- apps/desktop/src/renderer/src/styles.css`), remove any `cn` package it adds to `apps/desktop/package.json`, then `pnpm install`.
4. Run `pnpm exec prettier --write` on the changed files and review the diff.
5. Run `pnpm typecheck`, `pnpm lint` (stage first: the em-dash gate reads `git ls-files`), `pnpm format:check`, `pnpm --filter @videorc/desktop test`, `pnpm build && pnpm check:renderer-assets`.
6. Record the audiocn commit above.

## Not adopted

- `pan-control`: the backend folds the microphone to centred mono and has no
  pan or balance. Real pan is plan 093 Phase P, only on the owner's yes (D1).
- `volume-control`: a 0..1 player volume in percent; Videorc's gains are dB
  with boost, and it has no player (plan 093, D2).
- `SoloToggle` and `MonitorToggle`: no monitor bus. The one thing the
  streamer hears from Videorc is the soundboard (plan 189), behind its own
  "Hear sounds yourself" switch on Sources.
- `knob`: nothing in Videorc is a trim; faders suit keyboard-first rows.
- The Mix strip (`MixerMaster`): removed by the owner on 2026-10-02.
- `audio-device-select`: Base-only Select API; `DevicePicker` stays the one
  picker (plan 174 S1.9).
- `live-waveform`: adopted by plan 092 for the Sources mic preview, removed by
  plan 093 (2026-10-02). The Sources microphone strip's level meter replaced
  the preview, and nothing else drew a waveform.
- `channel-strip`: adopted by plan 093 for the Sources rows, removed by plan
  173 (2026-10-10). Its grid put every source in a different shape across a
  wide pane; the Sources rows (`components/sources/source-item.tsx`) give the
  Microphone and System audio the same shape as Screen and Camera, with the
  same audiocn controls inside.
- `audio-player`, `track-list`, `waveform`, `spectrum`, the
  smooth and electric visualizers, every block, and the Web Audio hooks.

Reasons, item by item: plans 092, 093 and 173. The Studio uses no mixer (owner
call, 2026-10-02); the audio controls live on Sources only.
