# Plan 196: the LCD meter for every audio level

**Status:** BUILT 2026-10-25 on the recommended defaults (D1 to D5), U1 to
S2; see [Execution notes](#execution-notes). Owed: audiocn PR #32 merged and
deployed, the live-mic CPU comparison (needs a Microphone grant for this
worktree's dev app), and the owner's by-eye.
**Priority:** P2. Owner request: "In our studio
instead of the meter for the microphone that we already have, let's plan to add
this one https://www.audiocn.dev/docs/components/lcd-meter. Also inside the
sources as well." **Size:** S: one line upstream in audiocn (U1) and two
Videorc slices (S1, S2). **Planned against:** Videorc `4891fc53` (origin/main)
and audiocn `bcc737f` (origin/main). audiocn.dev serves the same `lcd-meter`,
`lcd-display` and `level-meter`: byte-identical after Prettier. **Owner
route:** UI/Product Design (fit 9) owns S2; Implementation (fit 8) owns U1 and
S1. **Model lanes:** U1 and S1 `gpt-5.5`; S2 `opus-4.8` with the
`videorc-design` skill.

## Goal

Every audio level in Videorc draws on audiocn's LCD meter: the Studio
Microphone section, and the Sources Microphone, System audio and Sounds rows.
The data, the states and the DOM contracts stay the same; only the instrument
changes. Nothing is added to the eager bundle.

## What the user will see

- **Studio, Microphone.** Under the picker, a small LCD screen replaces the
  thin segmented bar. Block segments light from the left and one segment holds
  the peak. The level reads as digits on the right (`-18.0`, `−∞` at silence).
  A printed scale (`48 24 12 6 3 0`) has a bracket over the clip zone, and a
  `CLIP` flag inverts for 1.5 s when the signal clips.
- **Sources.** The same screen on the Microphone row, and on System audio and
  Sounds while a session mixes them. Outside a session those two rows keep
  "Level shows while recording or live."
- **Both themes, no colour.** Dark: white ink glowing on black glass. Light:
  black pixels on a pale grey backlit screen. The screen draws in Videorc's
  chrome (`--primary`).
- **Muted:** the screen dims to 50%, as the bar does today, and reads `−∞`.
- **Nothing moves.** Pickers, Mute, Gain, Level and Sync keep their homes.

## Verified facts (2026-10-25 spike)

A throwaway worktree of `4891fc53` installed `@audiocn/lcd-meter` with
`shadcn@4.21.1`, wired it into `MicLevelMeter`, and ran the gates. The
worktree was deleted afterwards.

### Install

1. The CLI wants 26 files (6 new, 20 overwrites of audiocn files Videorc
   already has) and 36 CSS variables. After Prettier, four of the 20 differ
   from Videorc's copies:
   - `components/ui/level-meter.tsx`: **needed.** `LcdMeter` imports
     `useLevelMeter` (now exported) and reads `zones` and `channelCount` from
     its context. It also brings audiocn #4 (`[overflow-anchor:none]` and room
     for a horizontal scale), which `docs/audiocn.md` lists as "upstream is
     ahead, not adopted yet".
   - `hooks/use-reduced-motion.ts`: **a trap.** Videorc's copy carries a local
     addition, `smoothScrollBehavior()` (plan 174 S1.8). The overwrite deletes
     it. Keep Videorc's.
   - `lib/audio/frame-loop.ts` (update and paint phases) and
     `lib/audio/types.ts` (three optional history fields): the LCD does not
     need them. Keep Videorc's, as the plan 189 install did.
2. Four new files the LCD never imports: `hooks/use-audio-context.tsx`,
   `lib/audio/click.ts`, `lib/audio/history.ts`,
   `lib/audio/history-playback.ts`. Drop them.
3. Kept: `components/ui/lcd-display.tsx`, `components/ui/lcd-meter.tsx` and the
   updated `level-meter.tsx`. No dependency change: `@base-ui/react` and
   `class-variance-authority` are already installed.
4. `pnpm typecheck` passes (renderer `lib` ES2022; nothing ES2023).

### Gates the vendored files trip

| Gate                                 | File                                                                                                                  | Why                                                                                                                  | Fix                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| ESLint Base UI fence                 | `lcd-display.tsx`                                                                                                     | imports `@base-ui/react/select` for `LcdDisplaySelect`                                                               | add `lcd-display` to `AUDIOCN_BASE_UI_FILES` (S1)           |
| Style guard: no `cursor-pointer`     | `lcd-display.tsx`                                                                                                     | `LcdDisplaySelectTrigger`                                                                                            | upstream (U1)                                               |
| Style guard: colour literals         | `lcd-display.tsx`                                                                                                     | the bezel, glass and shadow values and the four hardware inks, as `oklch()` and `rgb()`                              | allowlist the file (S1); Videorc uses `--primary` only (D1) |
| Style guard: radius tiers            | `lcd-display.tsx` (`rounded-lg` bezel, `rounded-md` screen, `rounded-sm` select), `lcd-meter.tsx` (`rounded-sm` CLIP) | audiocn's own radii                                                                                                  | allowlist both (S1), as `mixer.tsx` and `sound-pad.tsx` are |
| `dock-slot.test.ts` overlay coverage | `lcd-display.tsx`                                                                                                     | the file portals (its select), so the test asks for its `lcd-display-content` and `lcd-display-select-content` slots | classify both as non-blocking (S1)                          |
| `microphone-section.test.ts`         | Videorc's test                                                                                                        | pins `data-slot="level-meter"`                                                                                       | rewrite for the LCD (S2)                                    |

Everything else passed with the LCD wired in: the full desktop suite (5,311
tests), lint, the data-slot, status-colour, 11 px, dialog and control-size
guards, `use-studio-context-partition.test.ts` and
`studio-mic-meter.integration.test.ts`. The one other red,
`renderer-security-policy.test.ts`, needs the Electron binary, which the spike
skipped (`pnpm install --ignore-scripts`).

### Bundle

- **Eager:** `check:renderer-assets` read 394,285 gzip bytes before the wiring
  and 394,294 after (+9 gzip, +34 raw: chunk-name churn in the entry). Main
  itself has only 706 gzip bytes of headroom under the 395,000 ceiling, so an
  eager import of the LCD would fail the budget.
- **Lazy:** +32.3 KB raw in total, mostly class strings. The LCD lands in the
  chunk Studio and Sources share (`channel-toggle-*.js`: +25.6 KB raw, 14.5 KB
  gzip for the whole chunk) and in `db-scale-*.js` (+6.7 KB raw).
- **Base UI Select is tree-shaken.** `lcd-display.tsx` imports it, but the
  build output has no select code (`@base-ui/react` is `sideEffects: false`).

### Look

Rendered in headless Chrome with Videorc's built CSS, in a 360 px column, in
both themes:

- **Height.** Today's bar is 8 px. The LCD's full screen is 88 px at `sm` and
  95 px at `default`. Without the scale it is 85 px at `sm`: the CLIP flag
  keeps its own row, so dropping the scale saves almost nothing.
- **Text size.** At `sm` the scale and CLIP print at 0.75 em = 10.5 px, under
  Videorc's 11 px floor (F-14, H-17). The guard only matches `text-[Npx]`, so
  it does not fail. At `default` they print at 13.5 px and the readout at
  18 px.
- **Ink.** With `variant="primary"`: white ink glowing on near-black glass in
  dark, black pixels on pale grey glass in light. With `amber`: a peach screen
  in light and an orange glow in dark.
- **CLIP.** A constant declarative value lit CLIP for one hold only:
  `ClipIndicator` re-arms on every frame above −1 dBFS. Live sources send
  about 20 frames a second, so a clipping microphone keeps it lit; the 1 Hz
  fallback re-arms once a second.

How the render was made: a scratch entry rendered `LcdDisplay` + `LcdMeter`
with declarative values, bundled with the repo's esbuild against
`tsconfig.web.json`, beside `out/renderer/assets/styles-*.css` from a build
that included the LCD files. Chrome ran with `--headless=new
--virtual-time-budget=4000 --force-device-scale-factor=2`.

## Design decisions

1. **One meter component.** `MicLevelMeter`
   (`components/studio/mic-level-meter.tsx`) stays the only meter Videorc
   renders, so Studio and Sources cannot drift apart. It draws
   `LcdDisplay` + `LcdMeter` instead of `LevelMeter`. Its input is unchanged:
   `MeterInput`, a source with `peak` ballistics or a value with `vu`.
2. **Videorc's ink.** `LcdDisplay` keeps its defaults, `variant="primary"` and
   `appearance="auto"`: the ink is Videorc's `--primary` (chrome), and the
   screen follows the theme. No call site passes `variant` or `appearance`; a
   test holds that.
3. **One ink, no zone colours.** The LCD shows "hot" with the bracket over
   the clip zone (from −9 dBFS, the default zones) and "clipping" with the
   CLIP flag. Today's amber and red segments go away (D4).
4. **Vendor pristine.** As in plans 092 and 093: fix upstream (U1), allowlist
   what is the instrument's own look, and style Videorc's use from outside
   with `className`. `docs/audiocn.md` keeps "Local patches: none".
5. **No new copy.** "Clip" is audiocn's default text, uppercased by the
   screen. The readout has no unit, as on audiocn.dev; the meter's
   `aria-valuetext` keeps the dB value for screen readers.
6. **Lazy stays lazy.** Only `mic-level-meter.tsx` imports the LCD, and only
   lazy chunks import it.
7. **One row.** Every Videorc meter source carries one channel
   (`backend-level-sources.ts`, `mic-frame-sources.ts`), so the screen draws
   one unlabelled row. L and R labels appear only for two channels.

## Owner decisions (recommended defaults; execution can start on them)

- **D1. Ink.** Recommended: Videorc's chrome (`primary`). Alternative:
  `amber`, the classic recorder screen. It is colour without information, and
  amber already means muted and warning in Videorc (the muted-speaker amber).
- **D2. What the screen shows.** Recommended: audiocn's full screen (bar, held
  peak, readout, scale with bracket, CLIP), as on the page the owner linked.
  Alternative: bar, held peak and CLIP only, closer to plan 092's review ("the
  microphone picker and its level and nothing else"). Dropping the scale alone
  saves 3 px, so the real choice is whether the readout stays.
- **D3. Size.** Recommended: `default` (95 px; every glyph clears the 11 px
  floor). Alternative: `sm` (88 px; the scale and CLIP at 10.5 px).
- **D4. Clipping colour.** Recommended: one ink, the LCD's design.
  Alternative: red ink on the row while it is in the clip zone, set from
  outside on `data-zone="clip"` (`--lcd-display-lit: var(--destructive)` on
  the channel; the glow stays chrome).
- **D5. Which Sources meters.** Recommended: all three (Microphone, System
  audio, Sounds), since they share `MicLevelMeter`. Alternative: Microphone
  only, which needs a second meter component for the other two.

## Slice U1 (audiocn): no pointer cursor on the LCD select

Work in `~/projects/audiocn` on its own branch. The checkout has an untracked
`output/`: leave it alone.

**Change:** in `components/ui/lcd-display.tsx`, `LcdDisplaySelectTrigger`
drops `cursor-pointer` and the then-pointless `disabled:cursor-default`. Plan
092 U1 did the same for `waveform.tsx`: Tailwind v4 buttons use the default
cursor, and desktop hosts such as Videorc ban the pointer.

**Verification (audiocn):** `pnpm test`, `pnpm typecheck`, `pnpm check`,
`pnpm build`, `pnpm test:install`; then deploy.

**Done when:** audiocn.dev's `r/lcd-display.json` contains no
`cursor-pointer`, and the audiocn commit is written into this plan.

**Fallback** if the owner would rather not change audiocn: S1 gives the
`cursor-pointer` guard a one-file exception for `lcd-display.tsx`, naming the
select trigger that Videorc never renders.

## Slice S1: foundation, no visible change

**Files** (renderer paths are under `apps/desktop/src/renderer/src/`):

- new `components/ui/lcd-display.tsx` and `components/ui/lcd-meter.tsx`;
  updated `components/ui/level-meter.tsx`;
- `eslint.config.mjs`, `renderer-style-guards.test.ts`, `lib/dock-slot.ts`;
- `docs/audiocn.md`, `.claude/skills/videorc-design/SKILL.md`.

**Changes:**

1. From `apps/desktop`, look first:
   `pnpm dlx shadcn@4.21.1 add @audiocn/lcd-meter --dry-run --diff`. Then
   install: `pnpm dlx shadcn@4.21.1 add @audiocn/lcd-meter --overwrite --yes`.
2. Keep exactly three files. From the repo root, restore the rest:

   ```sh
   R=apps/desktop/src/renderer/src
   git checkout -- $R/hooks $R/lib/audio $R/styles.css \
     $R/components/ui/db-scale.tsx $R/components/ui/db-readout.tsx \
     $R/components/ui/clip-indicator.tsx
   rm $R/hooks/use-audio-context.tsx $R/lib/audio/click.ts \
     $R/lib/audio/history.ts $R/lib/audio/history-playback.ts
   ```

   `git status --short` must then list only `lcd-display.tsx`,
   `lcd-meter.tsx` and `level-meter.tsx`. If the CLI touched
   `apps/desktop/package.json`, revert it. Any other file: stop and look.

3. `pnpm exec prettier --write` the three files.
4. `eslint.config.mjs`: add `'lcd-display'` to `AUDIOCN_BASE_UI_FILES`.
5. `renderer-style-guards.test.ts`:
   - `COLOUR_LITERAL_ALLOWLIST` gains `src/components/ui/lcd-display.tsx`,
     commented: audiocn's LCD (plan 196); its literals are the screen's bezel
     and glass and the hardware inks Videorc never selects; Videorc draws in
     `--primary`.
   - `OFF_TIER_RADIUS_ALLOWLIST` gains `lcd-display.tsx` and `lcd-meter.tsx`
     (the screen, its select and the CLIP flag keep the kit's radii).
   - `POPUP_TIER_FILES` gains `lcd-display.tsx` (the bezel's `rounded-lg`,
     10 px in Videorc).
   - Only if U1 has not landed: the cursor exception (U1's fallback).
6. `lib/dock-slot.ts`, `DOCK_NON_BLOCKING_SLOTS`:
   - `'lcd-display-content'`: the LCD's own screen, inline, never portalled;
   - `'lcd-display-select-content'`: the LCD select, which Videorc never
     renders (plan 196); classify it as a popper before using it.
7. `docs/audiocn.md`:
   - a row for `lcd-meter` (with `lcd-display`), home "Studio Microphone
     section and the Sources rows (`MicLevelMeter`)". The `level-meter` row
     stays (the LCD is built on it); its home becomes "Under `lcd-meter`".
   - "Installed from": the plan 196 items, the install date, the audiocn
     commit (U1's, else `bcc737f`), the three files kept and the restore list.
     Remove the "`level-meter` carries audiocn #4" bullet: it is adopted now.
   - Updating: add `@audiocn/lcd-meter` to the command, and note that
     `use-reduced-motion.ts` carries Videorc's `smoothScrollBehavior` and must
     be restored after `--overwrite` (the doc calls the file audiocn's own,
     which is no longer true).
   - Rules: the Base UI fence includes `lcd-display`; the LCD's materials are
     the allowlisted exception to the colour rule; the ink is `--primary`
     only.
8. Design skill, shadcn component mapping: audio levels draw on audiocn's LCD
   meter (`MicLevelMeter`) in Videorc's `--primary` ink; never a hardware ink.

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
- `git diff origin/main --stat` shows only the files above, and nothing
  imports `lcd-meter` yet;
- eager bytes equal main's.

## Slice S2: the switch

**Files:**

- `components/studio/mic-level-meter.tsx`;
- the callers: `components/studio/microphone-section.tsx` and
  `components/sources/sources-audio-mixer.tsx`;
- `components/tabs/studio-tab.tsx` (`MicrophoneSectionFallback`);
- `audiocn-adoption.test.ts`, `microphone-section.test.ts`,
  `sources-audio-mixer.test.ts`, new `mic-level-meter.test.ts`.

**Changes:**

1. `MicLevelMeter` renders the screen. Its props become `LcdMeter`'s minus the
   data props, so `orientation`, `variant`, `segments` and `size` are gone;
   `className` goes to `LcdDisplay`:

   ```tsx
   <LcdDisplay className={className} size="default">
     {meter.kind === 'source' ? (
       <LcdMeter ballistics="peak" source={meter.source} {...props} />
     ) : (
       <LcdMeter ballistics="vu" peakDb={meter.peakDb} {...props} />
     )}
   </LcdDisplay>
   ```

   A caller's `aria-label` and `data-videorc-*` attributes land on the
   `role="meter"` element (the `LevelMeter` root), as today. `size` follows
   D3. With D2's alternative, pass the anatomy as children
   (`LcdMeterChannel` > `LcdMeterTrack` > `LcdMeterBar` + `LcdMeterHold`,
   then `LcdMeterClip`) instead of the default rows.

2. The four call sites (Studio Microphone; Sources Microphone, System audio,
   Sounds) drop `orientation="horizontal"` and `variant="segmented"`. All else
   stays: the `data-videorc-mic-level` wrapper with `data-muted` and
   `opacity-50`, the off-screen monitor-state span, `data-videorc-mic-preview`,
   `data-videorc-system-audio-visualizer`, `data-videorc-sounds-visualizer`,
   the idle lines and the aria-labels.
3. `MicrophoneSectionFallback`: the meter skeleton takes the LCD's measured
   height (about 95 px at `default`), so the section does not jump when its
   chunk loads.
4. The Studio section's comment "Exactly the picker's width: the meter alone"
   describes the LCD screen instead.

**Tests:**

- `mic-level-meter.test.ts`: both inputs render one `role="meter"` inside
  `data-slot="lcd-display"` with `data-variant="primary"`,
  `data-appearance="auto"` and the D3 `data-size`; a caller's
  `data-videorc-*` attribute lands on the meter.
- `audiocn-adoption.test.ts`: a source scan finds `LcdDisplay` rendered only
  in `mic-level-meter.tsx`, never with `variant` or `appearance` (D1).
- `microphone-section.test.ts`: "spans the picker with the meter alone"
  becomes: the screen spans the picker (`flex-1` on
  `data-slot="lcd-display"`), its meter carries
  `data-videorc-mic-visualizer`, and the readout is the screen's own
  (`data-slot="lcd-meter-value"`, no ` dB`). Under D2's alternative, assert no
  readout instead. Keep the muted-dimming and state-span tests.
- `sources-audio-mixer.test.ts`: the three meters are LCD screens; idle System
  audio and Sounds rows show their line and no screen.

**Verification:** S1's commands, plus:

- `pnpm smoke:sources` (the Sources DOM contracts).
- **Live mic CPU.** `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm
smoke:preview-performance` on main and on the branch, same machine, quiet
  host. Renderer CPU must stay within 1 percentage point. The LCD repaints
  under a dot mask and a `drop-shadow` glow about 20 times a second, which the
  bar never did. A fresh worktree's dev Electron binary has no Microphone
  grant (TCC is per binary): grant it once or run where the grant exists, and
  say so if that blocks the run.
- **Idle.** Microphone muted, no session, Studio visible: renderer CPU equal to
  main (the meter sleeps once it settles).
- **Owner by-eye, light and dark:** Studio at its narrowest and widest
  inspector, and Sources. States: speech, loud, CLIP, muted, no microphone,
  silent, System audio and Sounds during a session, the idle rows.
- **Windows and Linux:** renderer-only change, covered by CI's renderer tests.
  The mono font falls back to each platform's own; a by-eye on the next
  Windows build is owed.

**Done when:** the gates are green, the CPU comparison is in the PR, and the
owner has accepted the by-eye (or changed any of D1 to D5).

## Out of scope

- The session mic sliver (five bars beside the status badge): a
  `BarVisualizer`, not a level meter.
- `LcdDisplay`'s rows, select and status pixel: Videorc's controls stay
  Videorc's.
- Vertical LCD meters: audiocn has none.

## Risks

- **Height.** The meter grows from 8 px to about 95 px in up to four places.
  The Studio inspector scrolls, and the Sources rows get taller. D2 and D3 are
  the levers.
- **Light theme.** The grey hardware bezel is the one solid surface on
  porcelain glass. The owner judges it by eye.
- **Glow cost.** Measured in S2 against main.
- **Eager budget.** Main has 706 gzip bytes of headroom. The LCD is lazy, but
  any eager import of it would fail `check:renderer-assets`.

## Execution notes

Built 2026-10-25 on the recommended defaults: chrome ink (D1), the full
screen (D2), `default` size (D3), one ink (D4), all three Sources rows (D5).

**U1 (audiocn PR #32, `5ffbf9f`, branch `fix/lcd-select-default-cursor`).**
`LcdDisplaySelectTrigger` lost `cursor-pointer` and `disabled:cursor-default`,
with a test that keeps any `cursor-*` class off it. The PR also formats
`lcd-meter.test.tsx`, which failed `pnpm check` on audiocn main. `pnpm test`
(494), `pnpm typecheck`, `pnpm check`, `pnpm registry:build` and `pnpm build`
pass. `pnpm test:install` did not run: `pnpm dlx shadcn@rc init` stopped on
pnpm's `ERR_PNPM_TRUST_DOWNGRADE` for `semver@6.3.1` under `@babel/core`
("possible package takeover"); that is the dependency tree, not this change,
and it was not overridden. Not merged or deployed yet.

**S1.** `@audiocn/lcd-meter` from audiocn.dev (`bcc737f`), then
`lcd-display.json` from a local registry build of U1, both through
`shadcn@4.21.1 add --overwrite`. The CLI rewrote the 20 shared files and
added 4; all were restored or dropped as planned. After Prettier,
`lcd-meter.tsx` and `level-meter.tsx` equal `bcc737f` and `lcd-display.tsx`
equals `5ffbf9f`. `package.json`, the lockfile and `components.json` did not
change. Gate edits as in S1 steps 4 to 8; no cursor exception was needed.

**S2.** `MicLevelMeter` draws `LcdDisplay` + `LcdMeter`; the four call sites
dropped `orientation` and `variant`; the Studio fallback skeleton is
`h-24 rounded-row` (96 px). New `mic-level-meter.test.ts`; the adoption test
holds D1; the Studio and Sources tests assert the screen.

**Gates** (on `90a91148`): `pnpm typecheck`, `pnpm lint` (the one warning,
`use-studio` line 12244, is on main), `pnpm format:check`, `pnpm build`.
`pnpm --filter @videorc/desktop test`: 5,345 passed and one failed,
`studio-provider.integration.test.ts` "starts one clean cut when a recording
finalizes", at load average 67; that file passed 188 of 188 twice when rerun
alone. `check:renderer-assets`: 394,539 gzip / 1,964,531 raw eager bytes
under the 395,000 ceiling. Before the rebase the same change read 394,306
against main's 394,285, so the LCD adds about 20 gzip bytes of chunk-name
churn to the entry; the rest of the rise is main's #797.

**Owed.**

- **The S2 live-mic CPU comparison.** Once the host quietened, the backend
  built in this worktree (7 min 39 s) and
  `VIDEORC_SMOKE_SKIP_PREBUILD=1 VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1
  pnpm smoke:preview-performance` ran on the branch and, after
  `git switch --detach origin/main` in the same worktree, on main. Both failed
  the same way, before measuring:
  - The probe looks for microphone options 250 ms after opening the picker,
    right after launch, and found none ("No available Studio microphone could
    be selected"). A scratch copy that waits up to 10 s selected one, so this
    is a probe timing bug on main (not fixed here).
  - With a microphone selected, the Studio meter mounted but never went live:
    `micLivePeakDb` stayed null. This worktree's dev Electron and backend have
    no macOS Microphone grant (TCC is per binary), and only the owner can
    click Allow.

  To run it: in `~/projects/videorc-wt-196`, `pnpm dev`, select a microphone
  and allow access once, quit, then run the command above on the branch and
  on main as described. The base probe, without the microphone, ran on the
  branch (1,800 frames; renderer 22.1%, GPU 19.0% at load average 34) and
  failed only its 80 KiB/s WebSocket ceiling at 84.4, backend traffic this
  renderer change does not touch; main's run of it was not taken.
- **`pnpm smoke:sources`** fails on main too, the same way: an extra
  `captureOff: undefined` key in the reconciled sources (a script assertion,
  no app; likely since #742). Not this change's.
- audiocn PR #32 merged and audiocn.dev deployed, so a re-install from the
  site matches `lcd-display.tsx`.
- The owner's by-eye in both themes (S2 list), and a look on the next Windows
  build.
