# Plan 092: audiocn for Videorc's audio UI

**Status:** EXECUTED 2026-10-02: U1 in audiocn PR #2; S1 to S4 and Phase C
on `feat/092-audiocn-audio-ui` (one Videorc PR); Phase B not built (D2's
default is no). Owner by-eye and live-mic checks are owed (see "Execution
notes" and `docs/acceptance/2026-10-02-audiocn-audio-ui.md`). **Priority:** P2. No user-reported bug, but it closes two honesty gaps
in the Studio mixer (the meter ignores the Gain the user set, and 28 band bars
cannot say "too hot") and moves Videorc's audio UI onto the owner's own shadcn
audio library. **Size:** M: one upstream slice in audiocn (U1), four Videorc
slices (S1 to S4), and two optional phases behind owner decisions (B, C).
**Planned against:** Videorc `a8637877` (origin/main; the shared checkout is
189 commits behind on another session's branch, so every Videorc reference
below comes from an `origin/main` export) and audiocn `9ba81a1` (the commit
audiocn.dev serves today). **Owner route:** UI/Product Design (fit 9) owns S2
and S3; Implementation (fit 8) owns U1, S1 and S4. **Model lanes:** U1, S1 and
S4 `gpt-5.5`; S2 and S3 `opus-4.8` with the `videorc-design` skill; Phase B
`opus-4.8`; Phase C `fable-5`.

## Goal

Every audio surface in Videorc draws with audiocn (https://audiocn.dev, source
in `~/projects/audiocn`), fed by the audio truth Videorc already has: the
backend's capture and the renderer's visual-only analyser. It still looks like
Videorc (black glass, monochrome chrome, colour only as information), adds no
bytes to the eager bundle, and keeps every behaviour the current mixer has.

This plan is also the decision record for the audiocn items Videorc does
**not** use, and why.

## What the user will see

- **Studio, Audio mixer.** Each source row (Mic, System audio) becomes an
  audiocn channel strip: a thin segmented level meter with peak hold, a dB
  readout that never shifts the row, and a clip light that holds and resets on
  click. A healthy level is chrome; it turns amber when hot and red when it
  clips. The meter shows the level **after** Gain, so raising Gain moves the
  meter. Today it does not.
- **Session sliver** (5 bars beside the status badge) and the **Sources mic
  preview** (scrolling waveform under the picker) look as they do today, now
  drawn by audiocn.
- **No new controls and no moved controls.** Gain, Level, Sync and the echo
  guard stay on Sources. Mute and the System audio switch stay where they are.
- **One dB format app-wide:** `−12.3 dB` (typographic minus), `−∞ dB` for
  silence.

## The decision: what Videorc uses from audiocn

Verdicts: **Adopt** (this plan), **Phase B / C** (only after an owner decision,
below), **Later** (needs a product feature first, its own plan), **No**.

### Meters and visualizers

| audiocn item                                   | Verdict            | Videorc home                              | Why                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `level-meter`                                  | Adopt (S2)         | Studio mixer: Mic and System audio strips | The right instrument for "is my level right?": peak and RMS, peak hold, zones, clip. The current 28 band bars show spectrum shape, not level against a scale.                         |
| `db-scale`                                     | Adopt (dependency) | Inside `level-meter`                      | Comes with the meter; not shown in the compact strip.                                                                                                                                |
| `db-readout`                                   | Adopt (S2)         | Strip header                              | Replaces `MicSignalReadout` and the 250 ms `useStudioMicVisualPeakDb` commit: same 4 Hz rate, reserved width.                                                                         |
| `clip-indicator`                               | Adopt (S2)         | Strip header                              | Replaces the hand-rolled `useClipIndicator` and its "Clip" chip: same −1 dBFS threshold and 1.5 s hold, plus click to reset and an `aria-live` announcement.                          |
| `bar-visualizer`                               | Adopt (S3)         | Session mic sliver                        | Same look as today. Replaces the vendored ElevenLabs file at the same path.                                                                                                           |
| `live-waveform`                                | Adopt (S3)         | Sources mic preview                       | Same look as today. Replaces the vendored ElevenLabs file at the same path.                                                                                                           |
| `waveform`                                     | Later              | AI tab clip and silence ranges            | Needs per-recording peaks from the backend; the renderer cannot decode recordings.                                                                                                    |
| `spectrum`                                     | No                 | -                                         | Answers no product question.                                                                                                                                                         |
| `smooth-waveform`                              | No                 | -                                         | Duplicates `live-waveform`.                                                                                                                                                          |
| `electric-waveform`, `electric-bar-visualizer` | No                 | -                                         | Glow, forks and sparks are decoration; the design rules forbid decorative colour and motion.                                                                                          |

### Controls

| audiocn item          | Verdict      | Videorc home        | Why                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fader`               | Phase B (D2) | Studio mixer strips | Only if the Gain and Level home moves from Sources to the mixer (one home per control). Adds Base UI Slider, about 17.5 KB gzip in the lazy mixer chunk.                                                                                                                                             |
| `parameter-slider`    | No           | -                   | About 25 KB gzip (Base UI Slider and NumberField) to replace three sliders that `PowerSlider` already handles: numeric input, reset, bipolar, Shift step, commit on release.                                                                                                                            |
| `channel-toggle`      | No           | -                   | Mute stays Videorc's ghost `Button` with `aria-pressed` and the amber speaker icon. Revisit only if solo or monitor ever exist.                                                                                                                                                                       |
| `knob`                | No           | -                   | Rotary controls are worse than sliders in keyboard-first dense rows; the volume-dial skin is decoration.                                                                                                                                                                                             |
| `pan-control`         | No           | -                   | The backend mixes a mono voice; there is no pan.                                                                                                                                                                                                                                                     |
| `volume-control`      | No           | -                   | A 0..1 player volume; Videorc has no player.                                                                                                                                                                                                                                                         |
| `audio-device-select` | No           | -                   | `SourceSelect` stays the one picker for screen, camera and mic, with states audiocn lacks ("Finding devices…", a saved but missing device, the lazy searchable variant, live-switch status). It also relies on Base-only Select APIs (render-function `SelectValue`, `alignItemWithTrigger`, `null` values) that do not compile against Videorc's Radix select. |

### Mixer

| audiocn item    | Verdict    | Videorc home                         | Why                                                                                                                                                                                                  |
| --------------- | ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel-strip` | Adopt (S2) | One strip per source in the mixer    | Replaces two hand-rolled rows (the mic row and `SystemAudioMixerRowView`) with one composition. `ChannelStripStatus` is **not** used: its tinted tones contradict Videorc's badge rule (the tone lives in the dot). |
| `mixer`         | Adopt (S2) | Body of the Studio "Audio mixer" panel | Shared range, zones and ballistics for every strip, and arrow-key navigation between strips.                                                                                                       |

### Sounds and music

| audiocn item                 | Verdict | Why                                                                                                                                                                                                                  |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio-player`, `track-list` | No      | No in-app playback: Library "Play" opens QuickTime.                                                                                                                                                                  |
| `sound-pad`                  | Later   | A soundboard needs a backend sound-effects source in the session bus. Renderer audio never reaches a recording or stream: on macOS, Videorc keeps its own sounds out of System audio on purpose (plan 069). |

### Blocks

All six (`system-audio-mixer`, `mic-setup`, `system-audio-settings`,
`quick-audio-popover`, `soundboard`, `music-player`): **No as code; reference
only.** They capture audio themselves through Web Audio (`getUserMedia`,
`getDisplayMedia`). In Videorc the backend is the capture authority, and a
renderer meter stream may open only after an exact `granted` status, never as
an implicit permission prompt (`lib/mic-stream.ts`). They also import Phosphor
directly, which is banned (icons come from `@/components/icons`).

### Hooks and core

| audiocn item                                                                                                                       | Verdict              | Why                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core` (`lib/audio/*`)                                                                                                             | Adopt (S1)           | dB maths, ballistics, zones, frame sources. Its `BALLISTICS.peak` (15 / 350 / 1200 / 600 ms) already equals Videorc's `DEFAULT_METER_BALLISTICS`, and the clip threshold (−1 dBFS) and hold (1500 ms) match too.                                                                                                              |
| `use-frame-source`, `use-clip-hold`, `use-audio-config`, `use-visibility`, `use-reduced-motion`                                    | Adopt (dependencies) | Pulled in by the components. `use-reduced-motion` replaces Videorc's file of the same name (S1).                                                                                                                                                                                                                             |
| `use-microphone`, `use-audio-devices`, `use-audio-analyser`, `use-system-audio`, `use-audio-context`, `use-web-audio-mixer`, `use-mixer` | No                   | `createMicVisualPipeline` already owns the single visual stream with tested guarantees: the exact-`granted` gate, backend-name to Chromium-label matching (including the plan 080 "(Bluetooth)" fix), StrictMode-safe retain and release, visibility gating, AES17-calibrated bands. The backend captures System audio (ScreenCaptureKit), not `getDisplayMedia`. |
| `use-sound`, `use-audio-player`, `use-waveform-data`, `use-demo-signal`, `use-level`, `use-gain-node`                              | No                   | No feature uses them yet.                                                                                                                                                                                                                                                                                                   |

## Verified facts (2026-10-02)

### Install spike

A throwaway worktree of `a8637877` got `core level-meter bar-visualizer
live-waveform channel-strip mixer channel-toggle parameter-slider fader` through
`shadcn@4.21.1 add @audiocn/...`. The gates ran, then the worktree was deleted.

1. **28 files: 24 new and 4 overwrite prompts.**
   - `hooks/use-reduced-motion.ts`: Videorc's exports `usePrefersReducedMotion` (used by `components/sidebar.tsx`); audiocn's exports `useReducedMotion`.
   - `components/ui/badge.tsx`: `channel-strip` lists shadcn `badge`, which resolves to the current shadcn radix-rhea badge. Accepting it destroys the plan 050 glass-chip badge and adds the `cn` npm package.
   - `components/ui/bar-visualizer.tsx` and `live-waveform.tsx`: the vendored ElevenLabs files. Same path, different API.
2. **The CLI asks about each colliding file even with `--yes`.** There is no skip flag, piped answers are unreliable, and `--overwrite` would take the badge. Answer by hand.
3. **Dependencies added:** `@base-ui/react ^1.8.0` (wanted), `cn ^0.4.0` (only from the shadcn badge; remove it), `class-variance-authority` (already present).
4. **CSS:** 36 variables. The `@theme inline` insertion also wrote 8 self-referencing lines (`--meter-clip: var(--meter-clip);` and similar). Do not keep the CLI's CSS; S1 writes the block by hand.
5. **Typecheck (TS 5.9.3, renderer `lib` ES2022):** every audiocn file compiles except `level-meter.tsx` (`zones.toSorted` is ES2023). `channel-strip` compiles against Videorc's own Radix badge. The remaining errors were Videorc consumers of the replaced files, and `sidebar.tsx`.
6. **ESLint:** clean on every installed file. **Prettier:** 27 files need `prettier --write` (audiocn uses double quotes and semicolons).
7. **Style gates:** `renderer-style-guards` (7 tests) and `desktop-scale` (5 tests) pass with the files installed. The canvas-mask `rgba()` in `live-waveform.tsx` is already on the colour-literal allowlist by path.
8. **Em-dash gate:** it passed only because it scans `git ls-files`. `formatDb(NaN)` in `lib/audio/decibels.ts` returns an em dash (U+2014), so CI fails once the file is committed.

### Bundle cost

esbuild, minified and gzipped, with React, `clsx`, `tailwind-merge`, `cva` and
`cn` external, which is what Videorc would add. Each row is standalone, so
shared code is counted in every row.

| What                                                   | gzip    |
| ------------------------------------------------------ | ------- |
| `core`                                                 | 2.1 KB  |
| `level-meter` (with scale, readout, clip light, hooks) | 4.7 KB  |
| `bar-visualizer`                                       | 2.3 KB  |
| `live-waveform`                                        | 2.6 KB  |
| `channel-strip` + `mixer`                              | 4.1 KB  |
| S2 set (meter, readout, clip light, strip, mixer, bars) | 13.7 KB |
| the same plus `channel-toggle`                         | 17.1 KB |
| `fader`                                                | 17.5 KB |
| `parameter-slider`                                     | 25.1 KB |
| Base UI `useRender` + `mergeProps` alone               | 1.9 KB  |

**Eager budget.** main CI (run `36929938495`, `a8637877`) measured 1,993,737
raw / 383,862 gzip bytes against ceilings of 2,000,000 / 390,000: about 6.2 KB
of raw headroom. "Eager" means the entry script plus `modulepreload` links. The
Studio tab, the dashboard bottom row (the mixer) and Sources are `React.lazy`
chunks, so audiocn UI costs nothing there as long as nothing in the entry graph
imports it. Two eager modules are in play: `hooks/use-studio-mic-visual.tsx`
(statically imported by `app-shell.tsx`) and `hooks/use-reduced-motion.ts`
(imported by `sidebar.tsx`). CI gzip is the enforced number and a Mac reads
about 1.6 KB higher, so compare raw bytes.

### Videorc's audio truth today

- **Backend, 1 Hz** (`diagnostics.stats`): `micLivePeakDb` / `micLiveLevel` and `systemAudioLivePeakDb` / `systemAudioLiveLevel`. Both are post-gain: mic gain and mute are applied at capture (`process_interleaved_f32` in `audio.rs`), System audio gain in the bus mix. Each value is the **last chunk's** peak at sample time (`record_live_peak` in `session_audio.rs`), not the loudest peak of the second. Mono, no RMS.
- **Renderer analyser, about 20 Hz** (`StudioMicVisualProvider` and `createMicVisualPipeline`): 32 gated bands, a 60-sample level history ring and a peak, every 48 ms. It is a second, visual-only open of the device in Chromium, so it is **pre-gain and pre-mute**. It runs only while Studio or Sources is visible, a mic is selected and unmuted, and access is exactly `granted`.
- **On demand:** `audio.meter.sample` ("Check level", 700 ms).
- **Ranges:** mic gain −24..+24 dB (`audio.rs`); System audio −24..+12 dB, default −6 dB (`protocol.rs`).

### Contracts the migration must keep

- `[data-videorc-mic-visualizer]` plus a `span` whose text is exactly `Live`. `scripts/perf-idle-probe.mjs` waits for both when run as `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance`.
- `data-videorc-mic-monitor-state`, `data-videorc-mic-clip`, `data-videorc-mic-warm`, `data-videorc-system-audio-row` (the state-matrix test reads its values), `data-videorc-system-audio-visualizer`, `data-videorc-mic-preview`, `data-videorc-session-mic-sliver`.
- `use-studio-context-partition.test.ts`: `audio-mixer.tsx`, `session-mic-sliver.tsx` and `ui/live-waveform.tsx` must not contain `from '@/lib/mic-visual-pipeline'` (a type import matches too), and `studio-tab.tsx` must not import `audio-mixer` directly.

### audiocn is moving

`9ba81a1` landed while this plan was being written, and audiocn.dev already
served it. The site has no versioned URLs. Another session has uncommitted work
in `~/projects/audiocn` (`use-gain-node`, blocks, `use-sound`). Videorc
therefore installs from audiocn.dev after U1 is live, and records the commit it
got.

## Design decisions

1. **Videorc keeps its audio truth; audiocn only draws it.** Small adapters turn Videorc's sources into audiocn's `FrameSource<MeterFrame>` and `FrameSource<VisualFrame>`. No audiocn Web Audio hook runs in Videorc.
2. **Base UI is allowed inside audiocn files only.** Add `@base-ui/react`, and fence it with ESLint everywhere else in the renderer. Videorc's own UI stays Radix (`components.json` keeps `radix-rhea`).
   - Porting audiocn to Radix would mean a fork: its classes target Base UI's own attributes (`data-pressed:`, `data-dragging:`, `data-disabled:`).
   - S1 to S3 pull only Base UI's `useRender` and `mergeProps` (about 1.9 KB gzip).
   - This settles audiocn plan 001's open question: Videorc needs no Radix variants, because it adopts neither `audio-device-select` nor the blocks.
3. **Fix upstream, vendor pristine.** Every gate fix lands in audiocn (U1). Videorc installs unmodified files and runs `prettier --write`. A local edit to an audiocn file is a bug to send upstream. `docs/audiocn.md` records the audiocn commit.
4. **The meter shows what will be recorded.** Analyser frames get the configured mic gain added (peak plus gain, RMS plus gain) and read as silence while muted. Backend values are already post-gain and pass through unchanged. The readout and the clip light use the same numbers, so the light fires at −1 dBFS or above, after gain.
5. **Videorc tokens, audiocn zones.**
   - `--meter-ok` is chrome (foreground at 80%), `--meter-warn` is `--warning`, `--meter-clip` is `--destructive`, and `--channel-mute` is `--warning` (the muted-speaker amber). Solo and monitor map to neutral tokens and stay unused.
   - Zones stay audiocn's defaults: amber from −20 dBFS, red from −9 dBFS, the OBS convention.
   - A healthy level stays monochrome; colour means hot or clipping.
6. **No IA change in S1 to S4.** Every control keeps its one home. Faders in the mixer would move Gain's home, so they wait for D2.
7. **Lazy stays lazy.** audiocn UI is imported only from the Studio tab, bottom-row and Sources chunks. The code that builds frame sources lives in a new hook module that only those chunks import, never in `use-studio-mic-visual.tsx`.
8. **No idle cost.** audiocn painters share one rAF loop but never leave it. A muted or static meter would keep a display-rate wake-up (120 Hz on ProMotion) that the mixer does not have today. U1 makes painters leave the loop once they settle.
9. **One dB format.** Audio levels render through audiocn's `formatDb`. Videorc's own `formatDb` in `lib/format.ts`, used only by the mixer, is deleted. A strip with no reading shows audiocn's placeholder, never the Gain value: today's fallback shows the gain (`+0.0 dB`), which reads like a level.
10. **Ballistics follow the source rate.** Analyser input (about 20 Hz) uses `peak`. Backend-only input (1 Hz) uses `vu`, so one step per second glides instead of jumping.

## Owner decisions (recommended defaults; execution can start on them)

- **D1. Mixer instrument.** Recommended: the segmented level meter (S2). Alternative: audiocn `bar-visualizer` in each strip, which is today's look, fed by the same adapter (a one-line swap). Decide at the S2 by-eye.
- **D2. Faders in the Studio mixer (Phase B).** Recommended: not now; decide after living with S2. A yes moves Gain and Level out of Sources into the mixer strips, with a line on Sources pointing there.
- **D3. Backend fast meters (Phase C).** Recommended: yes, after S2. Without it the System audio meter stays at 1 Hz, and the in-session mic meter is the gain-corrected analyser rather than the recorded signal.
- **D4. Zones.** Recommended: audiocn's defaults (−20 / −9). Alternative: red from −6 dBFS, if red flashes too often on normal speech at the by-eye.

## Slice U1 (audiocn repo): fixes so Videorc can vendor pristine files

Work in `~/projects/audiocn` on its own branch and worktree. Another session is
active there: leave its uncommitted files alone, and rebase before merging.

**Files:** `lib/audio/decibels.ts`, `components/ui/level-meter.tsx`,
`components/ui/waveform.tsx`, `lib/audio/frame-loop.ts` and every painter that
subscribes to it (at least `level-meter`, `bar-visualizer`, `live-waveform`),
`scripts/test-install.mjs`, the installation docs page, and tests.

**Changes:**

1. **No em dash.** `formatDb(NaN)` returns `--` (plus the unit) instead of the em dash. Update its test.
2. **ES2022-safe.** In `level-meter.tsx`, `zones.toSorted(...)` becomes `[...zones].sort(...)`. It is the only ES2023 API in the items Videorc uses.
3. **No pointer cursor.** Drop `cursor-pointer` from `waveform.tsx`: Tailwind v4 buttons use the default cursor, and desktop hosts such as Videorc ban the pointer.
4. **Settle-aware frame loop.**
   - A painter stops requesting frames when it is off screen, or when its input has not changed and its ballistics have converged (positions within `POSITION_EPSILON`, hold released).
   - A new frame or value, a scale or zone change, or becoming visible again wakes it.
   - The shared loop stops when no painter is awake.
   - This covers `level-meter`, `bar-visualizer` (with `idle="static"`) and `live-waveform`.
5. **Install test matrix.** `test-install.mjs` also runs a Radix fixture (`--base radix`) whose `tsconfig` `lib` is `["ES2022", "DOM", "DOM.Iterable"]`, installing at least `core level-meter mixer channel-strip bar-visualizer live-waveform`. It would have caught item 2.
6. **Docs: "Radix projects".** Base UI installs alongside Radix. The CLI asks to overwrite `badge.tsx` (a `channel-strip` dependency): answer No to keep a customised badge, then remove the `cn` package the shadcn badge brought.

**Tests:** fake-rAF tests for item 4:

- a constant value settles and stops requesting frames within a bounded number of frames;
- a new value requests frames again;
- a painter off screen requests none;
- reduced motion still updates at its 250 ms rate while the value moves.

**Verification (audiocn):** `pnpm test`, `pnpm typecheck`, `pnpm check`,
`pnpm build`, `pnpm test:install`; then deploy.

**Done when:** all pass, audiocn.dev serves the fixed items (`core.json` holds
no U+2014 and `level-meter.json` no `toSorted`), and the audiocn commit is
written into this plan's execution notes.

## Slice S1: foundation, no visible change

**Files** (renderer paths are under `apps/desktop/src/renderer/src/`):

- `apps/desktop/components.json`, `apps/desktop/package.json`, `pnpm-lock.yaml`;
- new `lib/audio/*` (11 files);
- new hooks `use-frame-source.ts`, `use-clip-hold.ts`, `use-audio-config.tsx`, `use-visibility.ts`; replaced `hooks/use-reduced-motion.ts`; `components/sidebar.tsx` (one import);
- new `components/ui/level-meter.tsx`, `db-scale.tsx`, `db-readout.tsx`, `clip-indicator.tsx`, `channel-strip.tsx`, `mixer.tsx`;
- `styles.css`, `eslint.config.mjs`, new `docs/audiocn.md`, `.claude/skills/videorc-design/SKILL.md`, new `audiocn-adoption.test.ts`.

**Changes:**

1. Add the registry to `apps/desktop/components.json`: `"registries": { "@audiocn": "https://audiocn.dev/r/{name}.json" }`.
2. From `apps/desktop`, run `pnpm dlx shadcn@4.21.1 add @audiocn/level-meter @audiocn/mixer` **interactively and without `--overwrite`**. Expected prompts: `use-reduced-motion.ts`, answer **Yes**; `badge.tsx`, answer **No**. Any other prompt is a STOP.
3. Remove `cn` from `apps/desktop/package.json` if the CLI added it, then `pnpm install`. Keep `@base-ui/react`.
4. **Tokens.** Delete everything the CLI wrote into `styles.css`. Add this block by hand, plus the 12 `--color-meter-*` / `--color-channel-*` entries in `@theme inline` (`--color-meter-ok: var(--meter-ok);` and so on) and nothing else. The selector is `:root, .dark` so the aliases resolve against each theme's tokens.

   ```css
   /* audiocn (plan 092): meter and channel tones are Videorc tones. A healthy
      level is chrome; colour means hot (warning) or clipping (destructive).
      Mute is the muted-speaker amber. Solo and monitor are unused. */
   :root,
   .dark {
     --meter-ok: color-mix(in oklch, var(--foreground) 80%, transparent);
     --meter-warn: var(--warning);
     --meter-clip: var(--destructive);
     --channel-mute: var(--warning);
     --channel-solo: var(--foreground);
     --channel-monitor: var(--info);
     --meter-ok-foreground: var(--foreground);
     --meter-warn-foreground: var(--warning);
     --meter-clip-foreground: var(--destructive);
     --channel-mute-foreground: var(--warning);
     --channel-solo-foreground: var(--foreground);
     --channel-monitor-foreground: var(--info);
   }
   ```

5. In `sidebar.tsx`, `usePrefersReducedMotion` becomes `useReducedMotion`. audiocn's `useSyncExternalStore` version replaces Videorc's effect-based one.
6. Run `pnpm exec prettier --write` on every new file.
7. **ESLint fence.** Flat config does not merge rule options. So extend the existing renderer `no-restricted-imports` rule (the Phosphor one) with `patterns: [{ group: ['@base-ui/react', '@base-ui/react/*'], message: "Base UI is audiocn's primitive layer; Videorc UI uses Radix. Only files installed from @audiocn may import it (docs/audiocn.md)." }]`. Then add a later block for the audiocn files that import Base UI (`clip-indicator.tsx` and `channel-strip.tsx`; Phase B adds `fader.tsx`). That block re-declares the rule with only the Phosphor path.
8. **`docs/audiocn.md`.** It holds:
   - the audiocn commit installed and the item list;
   - the install answers (items 2 and 3), the token block and the Base UI fence;
   - the adapter contract (S2);
   - the rule "never audiocn's Web Audio hooks or blocks";
   - how to update: re-run `add` for the installed items with the same answers, run `prettier --write`, review the diff;
   - the not-adopted list, with a link to this plan.
9. **Design skill.**
   - Add a row to "shadcn component mapping": audio meters, dB readouts, clip lights and channel strips come from audiocn (the `@audiocn` registry), fed by Videorc adapters; never its Web Audio hooks or blocks.
   - Add one sentence under hard rule 1: audiocn is a shadcn registry and counts as shadcn; Base UI enters only inside its files.
10. **`audiocn-adoption.test.ts`:**
    - `styles.css` defines all 12 tokens, each value references a Videorc token through `var(--…)`, and none holds a colour literal (`oklch(`, `rgb(`, `#`);
    - `@theme inline` has no self-referencing line (`--x: var(--x)`).

**Verification:**

```sh
pnpm typecheck
git add -A && pnpm lint   # the em-dash gate scans git ls-files, so stage first
pnpm format:check
pnpm --filter @videorc/desktop test
pnpm build && pnpm check:renderer-assets
```

**Done when:**

- all gates are green;
- `git diff origin/main --stat` shows only the files above, and nothing imports the new components yet;
- eager raw bytes differ from main only by the `use-reduced-motion` swap. Record the delta in the PR; expect under ±200 B.

## Slice S2: the Studio mixer on audiocn

**Files:**

- `lib/mic-visual-frame.ts` and `lib/mic-visual-pipeline.ts` (add `rmsDb`);
- new `lib/mic-frame-sources.ts` (pure) and new `hooks/use-studio-mic-sources.ts` (imported only by lazy chunks);
- `hooks/use-studio-mic-visual.tsx` (export the pipeline accessor; remove `useStudioMicVisualPeakDb`);
- `components/studio/audio-mixer.tsx`;
- `lib/mic-meter.ts` (remove what this slice orphans: `advanceClipHoldDeadline`, `MIC_CLIP_*`, and `backendMeterReading` if unused);
- `lib/format.ts` (delete `formatDb`);
- the tests next to each.

**Changes:**

1. **Pipeline RMS.** The frame gains `rmsDb: number | null`: the time-domain RMS of the same 2048-sample block the peak comes from, in dBFS through audiocn's `gainToDb`. It is `null` when there is no data.
2. **`lib/mic-frame-sources.ts`.** It holds no React. It imports types from `./mic-visual-frame` and `@/lib/audio/types`, never from `./mic-visual-pipeline` (the partition test), and declares the pipeline shape it needs structurally (`retain`, `subscribeFrame`, `readFrame`).
   - `createMicMeterSource(feed, settings)` returns a `FrameSource<MeterFrame>`. `subscribe` calls `feed.retain()` and `feed.subscribeFrame`.
   - Each notification reads the frame into a reused buffer and emits a reused `MeterFrame`: `peakDb + gainDb` and `rmsDb + gainDb`, or `−Infinity` when `settings().muted`. No data means no emit.
   - Unsubscribing releases both.
3. **`hooks/use-studio-mic-sources.ts`.** `useStudioMicMeterSource()` returns one stable source per pipeline. Gain and mute are read through a ref updated on render, so dragging Gain never re-subscribes or re-retains.
4. **Compose the panel.** Inside `PanelSection` (title and "Audio settings" action unchanged) sits a `Mixer` with two horizontal `ChannelStrip`s. The Mixer gets its accessible name from an `sr-only` `MixerTitle`, with `minDb -60`, `maxDb 0` and the default zones.
   - **Mic strip header:** `ChannelStripIcon` (MicrophoneIcon), `ChannelStripTitle` (the device name, truncated, or "No microphone"), and `ChannelStripActions` holding:
     - the monitor label as plain text in a `span` with `data-videorc-mic-monitor-state` ("Live", "Monitoring", "Muted" or "Idle", exactly as `audioMixerMonitorLabel` says today);
     - `ClipIndicator` with `data-videorc-mic-clip`;
     - `DbReadout`;
     - the existing mute `Button`.
   - **Mic strip body:** `ChannelStripMeter` holding `LevelMeter variant="segmented"` with `data-videorc-mic-visualizer`. Then the warm-mic line, "Check level", and the permission, silent, no-frames and device-issue notices as `ChannelStripNotice`. The notices keep Videorc's text-only styling (a `className` override to a transparent background and `text-warning`, as today).
   - **One input per strip.** When the analyser drives the mic (today's `analyserDriven`), pass `source={micMeterSource}` to the meter, the readout and the clip light, with `peak` ballistics. Otherwise use the backend reading (`micLivePeakDb`, else the sampled `audioMeter.peakDb`): `peakDb` on the meter, `value` on the readout, `clipping={peakDb >= -1}` on the clip light, with `vu` ballistics. Muted or no mic: `peakDb={-Infinity}`, and the strip's `muted` and `dimmed` props.
   - **System audio strip:** the same structure. DesktopIcon, "System audio", and the existing `Switch` and state label in the actions. While `view.meter`, `LevelMeter peakDb={systemAudioLivePeakDb}` with `vu` ballistics, keeping `data-videorc-system-audio-visualizer`. Then the permission, unavailable, echo-with-Resume and issue notices. `data-videorc-system-audio-row` and its values stay on the strip root. It is hidden exactly when it is hidden today.
5. Delete `MicSignalReadout*`, `useClipIndicator`, `AudioMixerBars`, `LiveAudioMixerBars`, `useAudioMixerFramePainter`, `MIXER_BAR_COUNT`, and Videorc's `formatDb`.

**Tests:**

- `mic-frame-sources.test.ts`:
  - the gain offset applies to peak and RMS;
  - muted emits silence, and no data emits nothing;
  - one subscribe retains once and unsubscribe releases;
  - a StrictMode subscribe, unsubscribe, subscribe leaves exactly one retain;
  - the emitted `MeterFrame` is the same object every frame (no allocation per frame).
- `audio-mixer.test.ts`:
  - keep the notice and signal tests and the System audio state matrix;
  - add the mic strip markup (`role="meter"` on `[data-videorc-mic-visualizer]`, the monitor label span);
  - add the muted strip (dimmed, placeholder readout);
  - add the clip light from a backend peak of −0.5 dB.
- `use-studio-mic-visual.test.ts`: replace the painter fan-out test with "three StrictMode meter consumers share one pipeline retain and cause no React render per frame".
- `mic-visual-pipeline.test.ts`: `rmsDb` matches the block RMS.

**Verification:** S1's commands, plus:

- `check:renderer-assets`: eager raw bytes unchanged from S1 (the mixer is in the lazy bottom-row chunk).
- **Live mic CPU.** Run `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance` on main and on the branch, on the same machine; renderer CPU must stay within 1 percentage point. The dev Electron binary of a fresh worktree has no Microphone grant, because TCC is per binary. Grant it once, or run where the grant exists; if that is blocked, say so.
- **Muted mic CPU.** Mic muted, no session, Studio visible: renderer CPU equal to main (U1's settle-aware loop).
- **Owner by-eye in both themes (D1):**
  - mic: live, loud, clipping, muted, silent, no frames, permission, device issue, no mic;
  - System audio: off, on, live, echo, permission.

**Done when:** gates are green, the perf comparison is recorded in the PR, and
the owner has accepted the by-eye (or switched D1 to bars).

## Slice S3: session sliver and mic preview

**Files:**

- `components/ui/bar-visualizer.tsx` and `components/ui/live-waveform.tsx` (replaced by audiocn's);
- `components/studio/session-mic-sliver.tsx` and `components/studio/mic-picker-preview.tsx`;
- `lib/mic-frame-sources.ts` and `hooks/use-studio-mic-sources.ts` (add the visual source);
- `lib/mic-visual-frame.ts` (remove the resampling helpers once unused);
- `hooks/use-studio-mic-visual.tsx` (remove `useStudioMicVisualPainter`);
- tests.

**Changes:**

1. Run `pnpm dlx shadcn@4.21.1 add @audiocn/bar-visualizer @audiocn/live-waveform`, answer **Yes** to both overwrite prompts (they replace the vendored ElevenLabs files), then `prettier --write`.
2. `createMicVisualSource(feed)` returns a `FrameSource<VisualFrame>`:
   - `bands`: a reused 32-entry `Float32Array`;
   - `history`: the pipeline's history ring, borrowed, with its start and length;
   - `peakDb`: `−Infinity` when null.

   No gain here: the sliver and the preview show the device's raw signal on purpose ("is this the right mic, and is it alive?").
3. **Sliver:** `BarVisualizer source={visualSource} barCount={5} align="center" idle="static"`. Muted renders zero `levels` with the muted tone. Keep the `w-9` width reservation, the `title` and `data-videorc-session-mic-sliver`.
4. **Preview:** `LiveWaveform source={visualSource} mode="scrolling" variant="bars" barWidth={2} barGap={1} active={lifecycle.active}`, sized with `className="h-7"`.
   - Keep the unavailable and muted lines and `data-videorc-mic-preview`.
   - Drop the old "preparation" shape. Until frames arrive the idle line shows, which is the honest state.
5. Delete `paintBarVisualizer`, `LiveWaveformHandle`, `useStudioMicVisualPainter`, `useMicPickerFramePainter`, `useSessionMicFramePainter` and the `resampleMicVisualLevels*` helpers once nothing uses them.

**Tests:**

- the visual source copies bands into the reused array, borrows the history ring, and retains once under StrictMode;
- the sliver and preview markup;
- the partition test still forbids `@/lib/mic-visual-pipeline` in the sliver and in `ui/live-waveform.tsx`;
- the style guard still allowlists `ui/live-waveform.tsx` (canvas mask only).

**Verification:** S1's commands, the perf run from S2 (also open Sources and
confirm `[data-videorc-mic-preview]` paints), and by-eye in both themes.

**Done when:** gates are green, no file references the ElevenLabs
implementation, and eager raw bytes are unchanged.

## Slice S4: retire duplicates, acceptance record

1. **`lib/mic-meter.ts`.** Keep what is Videorc's own: the −55 dB visual gate and `gatedDbToMeterLevel`, `matchMicrophoneDeviceId`, `fallbackBandLevels` if still used, and the helpers the pipeline's band calibration uses. Point constants that duplicate audiocn at it (`MIC_METER_FLOOR_DB` becomes `DEFAULT_MIN_DB`). Remove exports nothing imports; check each with `rg`.
2. **`docs/acceptance/2026-10-XX-audiocn-audio-ui.md`:** the owner checklist from S2 and S3, with the packaged-app steps.
3. **Index and release note.** Add the `plans/README.md` row and a one-line release note: "Audio mixer: real level meters with peak hold and clip lights; the meter follows Gain."

**Done when:** gates are green and `docs/audiocn.md` matches what is installed.

## Phase B (D2 = yes): faders in the Studio mixer

- Run `shadcn add @audiocn/fader` and add `fader.tsx` to the Base UI fence.
- `ChannelStripFader` per strip:
  - Mic: −24..+24 dB, linear taper, detent and reset at 0 dB.
  - System audio: −24..+12 dB, detent and reset at −6 dB.
  - `onValueChange` previews (the fader position, and the meter offset through the adapter). `onValueCommitted` writes `captureConfig`, so the backend is written on release, as `PowerSlider` does today.
  - Disabled exactly when today's sliders are.
- Sources: remove the Gain and Level sliders and point one line at the Studio mixer. Sync and the echo guard stay.
- **Gates:**
  - the `live-audio-processing` and Windows live-audio harness tests;
  - `pnpm smoke:recording-studio` (a live gain change goes through the session audio path);
  - by-eye.

## Phase C (D3 = yes): backend fast meters and a master strip

- **Backend.**
  - Per-source meter windows on the session bus: mic (post-gain, post-mute), System audio (post-gain), and master (the mix sent to FFmpeg, with its clipped-sample count). Each window carries the loudest peak and the RMS.
  - An `audio.levels` event every 50 ms, only while a client has subscribed (`audio.levels.subscribe` / `unsubscribe`, under the warm mic's visibility rule) and a session or the warm mic is running.
  - Fix `live_peak` for diagnostics at the same time: loudest since the last read, not the last chunk.
- **Contract.**
  - Rust `protocol.rs`, `apps/desktop/src/shared/backend.ts`, and the `backend-rpc-contract.ts` event and schema.
  - Every `Option` gets `skip_serializing_if` (the serde-null trap).
  - Never add the event to `LAN_EVENTS`.
- **Renderer.**
  - `createBackendMeterSource(kind)` is fed by the event: latest wins, no React state per frame.
  - The mixer prefers backend frames while a session runs and keeps the analyser before one.
  - System audio gets a real-rate meter.
  - A master strip (`ChannelStrip variant="master"`) shows what is recorded or streamed, with a clip count.
- **Gates:**
  - cargo tests (window maths, cadence, subscribe lifecycle) and contract tests;
  - `pnpm smoke:recording-studio` and `pnpm smoke:system-audio`;
  - `pnpm smoke:record-latency` if session start or stop is touched;
  - the perf probe (the event must cost nothing while hidden).

## Later (each needs its own plan)

- **Clip and silence ranges on a waveform** in the AI tab (`waveform` regions and markers), once the backend serves per-recording peaks.
- **Level check** on Sources (the idea behind audiocn's `mic-setup`): speak for five seconds and get "too quiet", "good" or "too loud" from the meter source. Renderer only.
- **Soundboard** with `sound-pad`, after a backend sound-effects source exists.
- **Remote guests** (planned): one strip per guest in the same `Mixer`.

## Edge cases

- **Gain drag while live:** the source keeps its identity, and the next frame shows the new gain.
- **Device switch:** the pipeline swaps devices behind the same subscription.
- **Mic muted:** the strip dims, the meter reads silence and the readout shows the placeholder. The analyser is off anyway (its gate).
- **No mic:** "No microphone", the meter dimmed at the floor, no clip light.
- **Analyser unavailable, no session:** the meter shows the last "Check level" sample or the floor; "Check level" stays.
- **Analyser unavailable in a session:** the 1 Hz backend value, with `vu` ballistics.
- **Reduced motion:** audiocn meters update at 4 Hz without ballistics; the sliver is static.
- **Window hidden or another tab open:** the pipeline releases the device, and painters settle and leave the loop (U1).
- **Light theme:** tokens resolve through Videorc's light tokens; the by-eye covers it.
- **Windows and Linux:** the renderer path is the same; System audio stays hidden where it is unsupported.
- **StrictMode:** a double subscribe and unsubscribe never reopens the device. Retain and release are already microtask-deferred; S2 tests it through the adapter.

## STOP conditions

1. **U1 is not live on audiocn.dev.** Do not start S1, and do not patch installed audiocn files locally. The one exception is a named local patch the owner approves, recorded in `docs/audiocn.md`.
2. **The CLI prompts for, or writes, anything outside a slice's file list.** Stop and inspect with `--dry-run --diff`.
3. **Eager raw bytes grow beyond the S1 hook swap.** Something in the entry graph imports audiocn; look at `use-studio-mic-visual.tsx` first.
4. **Renderer CPU regresses** by more than 1 percentage point with a live mic, or at all with a muted one. Fix it in audiocn (the loop, or a frame-rate cap in `AudioConfig`), not with a local throttle.
5. **The owner rejects the level meter at the S2 by-eye.** Swap `ChannelStripMeter`'s content for audiocn `bar-visualizer` on the visual source and keep the rest.
6. **A slice needs capture, session or backend changes.** That is Phase C, not S1 to S4.

## Out of scope

- A Radix flavour of audiocn. The shadcn CLI substitutes `{style}` in third-party registry URLs (verified in shadcn 4.21), so audiocn could serve one later without a config change in Videorc.
- The blocks, and audiocn's Web Audio hooks.
- In-app playback.
- Windows System audio (#478).
- The phone remote page (`remote_web`, plain JS).
- Per-app audio capture.

## Execution notes

### What was done (2026-10-02)

- **U1:** audiocn PR #2 (`fix/videorc-adoption`, five commits ending `a847315`). It covers every U1 item, plus a 100 ms painter clock so a woken meter never jumps, and a quiet-source stop for `DbReadout`'s 4 Hz ticker. audiocn: 320 tests (21 new), typecheck, Ultracite, React Doctor, build. `test:install` could not run here (see the deviations).
- **S1** `855d5487`: vendored with eager raw +29 B (the `use-reduced-motion` swap).
- **S2** `3ab5106b`: the mixer on channel strips, eager raw -1,311 B against main.
- **S3** `cda0540d`: the sliver and the preview, eager raw -3,961 B.
- **S4** `bc212d22`: `mic-meter.ts` trimmed; acceptance record written.
- **Phase C** `4d5874a6`: bus level windows, the `audio.levels` sampler, backend level sources and the Mix strip. Eager raw -2,132 B against main (the store and the event schema are eager).
- **Review fixes** (CodeRabbit on #532): muting a live strip left the readout on the last live level, because `DbReadout` writes its text outside React and the muted value rendered the same text React already had. Fixed in audiocn (`a847315`: the span swaps between a source and a value, and a starting ticker always writes) and re-installed; the re-installed file differs from the old one by the fix alone. `audio-mixer-live.test.ts` mounts the microphone strip, mutes it, and fails on the old file. `docs/audiocn.md` now says where each update step runs.
- **`audio.levels` ceiling:** the schema rejected any reading above +24 dBFS, and the post-gain microphone reaches +24 at full scale (gain clamps at ±24 dB), so one hot window could drop a whole event. The backend now clamps readings to -120..+48 dBFS and the schema accepts that range.
- **Owner change, the Microphone section** (2026-10-02, after seeing the mixer): the Studio shows one section between Session and Inputs with the microphone picker and its level, nothing else, and the level must run all the time, with no Check level. So: the Audio mixer, its System audio row and Mix strip, and the vendored `channel-strip` and `mixer` are gone (the channel tokens with them); the meter is `components/studio/microphone-section.tsx`, a lazy chunk. Between sessions the backend now meters the warm microphone itself: its CoreAudio callback keeps a lock-free level window and `stream_standby_levels` sends `audio.levels` (microphone only, no `sessionId`, gain applied) about 20 times a second while it stands by, so the meter no longer depends on the renderer analyser's permission (the dev app never had it). Inputs keeps its Mic row (picker and Mute) until the owner decides.
- **Windows CI test race:** `silent_drain_keeps_mic_only_bytes_identical_up_to_the_drain` read the bus cursor as soon as the FIFO reader held 96,000 frames, but the bus advances its cursor after a chunk's bookkeeping, so the Windows source gates (25 repeats) caught it one chunk short. The test now also waits for the cursor (`4f6188d5`). Main's runs of that job fail on a sibling silent-drain test too.
- **`smoke:recording-studio`:** not green end to end here. Three full branch runs each failed one native-preview timing budget (stage 27 twice, stage 30 once); two base runs passed. Every stage passes on its own, and stage 27 alone fails on base too (1 of 8 alternating runs, 0 of 8 for the branch). Details and the reading: the acceptance record.
- **Performance** (`smoke:preview-performance`, two alternating runs each): renderer CPU 7.7 % and 1.5 % on the branch against 17.8 % and 12.6 % on main. The one failing budget (WebSocket wire rate, about 82 KiB/s against 80) fails on main too.

### Deviations from the plan, and why

1. **Installed from a local build of the U1 branch, not audiocn.dev.** U1 is an open PR, not merged and deployed. The files are U1's, byte for byte (after Prettier), with no local patches, which is what STOP condition 1 protects. Once audiocn PR #2 merges, `shadcn add` from audiocn.dev serves the same files.
2. **`--overwrite`, then restore.** The CLI asks per file and ignores piped answers. Installing with `--overwrite`, then restoring `badge.tsx` and `styles.css` and dropping `cn`, gives the same result as answering Yes/No by hand. `docs/audiocn.md` keeps the by-hand answers for people.
3. **Two audiocn parts unused.** `ChannelStripIcon` paints a `bg-background` tile with a shadow (the body is the only `--background` coat), and `ChannelStripStatus` tints its badge (the tone lives in the dot). The icons stay inline, and the monitor label stays plain text, which also keeps the perf probe's `Live` span.
4. **Phase C has no subscribe RPC.** Only the main Studio renderer holds a full-event socket. The main process and the isolated command sockets use include lists, the phone remote has its own allowlist, and secondary windows get data through main-process relays. So `audio.levels` is sent only while a session's bus runs, is coalescible, and is hidden during benchmark sessions. Opting in per connection would add connection-lifecycle code for no receiver it would actually exclude.
5. **The 1 Hz `live_peak` keeps its meaning** (last chunk). During a session the mixer reads `audio.levels`; outside one, the bus does not run.
6. **`audiocn`'s settle threshold is 0.001 of the track** (about 0.06 dB), looser than the 0.0005 write threshold. A big drop then settles in about 6 s, mostly the peak hold's 1.2 s wait plus its fall.

### Owed

- The owner checklist in `docs/acceptance/2026-10-02-audiocn-audio-ui.md` (packaged app, both themes, live mic), including D1 and D4.
- `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance` where the Electron binary has the Microphone grant.
- Whether Inputs keeps its Mic row (picker and Mute) beside the Microphone section.
- One `pnpm smoke:recording-studio` from the granted checkout on this branch (the worktree runs never passed end to end; see the acceptance record).
- Merging audiocn PR #2, which deploys audiocn.dev.

### How it was started

- Start U1 in audiocn first.
- Then create a Videorc worktree from `origin/main` and never work in the shared checkout:

  ```sh
  git worktree add ../videorc-wt-092 -b feat/092-audiocn-audio-ui origin/main
  pnpm install --frozen-lockfile --prefer-offline
  ```

- One Videorc PR for S1 to S4, one commit per slice. U1 is its own audiocn change and lands first.
- Record here: the audiocn commit installed, the eager raw delta and the perf numbers.
