# Plan 093: a console-style Audio mixer on Sources, built from audiocn controls

**Status:** EXECUTED 2026-10-02, in review: S1 to S4 on
`plan/093-sources-audio-controls` (one Videorc PR); S0 waits for the owner to
merge audiocn PR #2 (the controls were installed from a local build of that
merge, see "Execution notes"); Phase P not built (D1 default: not now). Owner
request: "use components from audiocn.dev, like fader, parameter slider, pan
control, channel toggle, volume control, so the Sources page looks
professional." **Priority:** P2. No
bug; the Sources audio panel is the least finished surface in the app (see the
screenshot notes under "Sources today"). **Size:** M: one audiocn
prerequisite (S0), four Videorc slices (S1 to S4), and Phase P (real pan, a
backend change) only if D1 is yes. **Planned against:** Videorc `7b185ccd`
(origin/main, plan 092 merged) and audiocn `f53bfe6` (main, which is what
audiocn.dev serves today, checked 2026-10-02); audiocn PR #2
(`fix/videorc-adoption`, head `d4dfc0a`) is still open. **Owner route:**
UI/Product Design (fit 9) owns S2 and S3; Implementation (fit 8) owns S0, S1
and S4; Phase P is recording-output work (Diagnose/Implementation, fit 9).
**Model lanes:** S2 and S3 `opus-4.8` with the `videorc-design` skill; S0, S1
and S4 `gpt-5.5`; Phase P `fable-5`.

## Why this reverses part of plan 092

Plan 092 said No to `fader`, `parameter-slider` and `channel-toggle` for two
reasons. Neither holds for Sources:

1. **"Faders would move Gain's home."** 092 was about faders in the *Studio*
   mixer, which would have pulled Gain and Level off Sources. Sources already
   is the one home of Gain, Level, Sync, Mute and the System audio switch, so
   here the controls change shape in place and nothing moves.
2. **"PowerSlider already does it, for 17 to 25 KB."** The bytes land only in
   the lazy Sources chunk; eager bytes do not move. The owner wants the
   instruments for how they read, and that is a product call.

The Studio keeps exactly what the owner approved on 2026-10-02: the Microphone
section (picker plus level), no mixer, no Mix strip.

## Goal

The Sources "Audio mixer" panel reads like a small console: one channel strip
per source, each with a level meter that shows what is recorded, a fader, the
fader's value and the channel's toggle, all drawn by audiocn and styled by
Videorc's tokens. Every control keeps its home, its range, its value and its
live behaviour. Nothing on the panel pretends: no control ships without a
backend path behind it.

## What the user will see

Wide pane (a strip 36rem or wider puts the header beside the meter and fader):

```
 ◉ Audio mixer
   What your recording and stream hear, after gain. Nothing is processed automatically.

   Microphone
   [ Shure MV7+                                                         ⌄ ]
  ───────────────────────────────────────────────────────────────────────────
   🎙 Microphone   ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯     0.0 dB   [🔊]
      Live         ─────────────────────●───────────────────
      Sync                                          Reset  [  150 ms ]
      ──────────────────────────●───────────────────────────────────
      › Calibrate
  ───────────────────────────────────────────────────────────────────────────
   🖥 System audio ▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯   −6.0 dB   (On ●)
      On           ──────────────●──────────────────────────
      Everything your computer plays, except Videorc, including your own stream if it
      is open in a browser tab: mute that tab, because headphones don't stop it. ...
      Pause System audio if your stream echoes back                          (● )
```

Narrow pane (under 36rem the strip stacks on its own, by container query):

```
   🎙 Microphone · Live
   ▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯        0.0 dB   [🔊]
   ────────────────●──────────────
```

- **One strip per source.** Header (icon, name, state), a segmented meter, a
  fader under it, the fader's value, and the channel's toggle on the right.
  Strips are flush rows split by hairlines, like every other list in the app.
  The two boxed cards are gone.
- **Microphone.** Gain is a fader from −24 to +24 dB with a detent and a
  double-click reset at 0 dB; the fill grows from 0 dB both ways. Mute is an
  audiocn mute toggle (amber when pressed) instead of a switch. Sync is an
  audiocn parameter slider: a typed millisecond field you can also drag
  ("scrub"), and Reset. The calibration tools fold under "Calibrate".
- **System audio.** Level is a fader from −24 to +12 dB that resets to
  −6 dB. The On switch stays a switch. The meter moves while a session mixes
  System audio and rests outside one (D4). The explanation and the echo guard
  stay, as quiet rows under the strip.
- **Gone:** the row that repeated the microphone's name, the waveform box
  (empty in the owner's screenshot; the strip's meter replaces it on Sources,
  and Quick Settings keeps its waveform), and the number boxes beside Gain and
  Level.
- **Same behaviour.** Every value is written exactly as today and reaches a
  running session exactly as today. One honest addition: while a session
  runs, Sync says its change waits for the next recording or stream (it
  always did; the UI never said so).
- **Keyboard.** On a fader: arrows step 1 dB, Shift+arrows and Page Up/Down
  step 6 dB, Home/End jump to the ends, and double-click resets. Cmd/Ctrl+Up
  and Down move focus between strips (audiocn `MixerChannels`). The mute
  toggle's tooltip shows its global shortcut when one is bound.

## The five components the owner named, and the rest

Verdicts: **Adopt** (this plan), **D1** (owner decision, Phase P), **No**,
**Later** (its own plan).

| audiocn item                             | Verdict                      | Videorc home                                | Why                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fader`                                  | Adopt (S2, S3)               | Microphone Gain, System audio Level         | The instrument for a gain: a fill from an origin, detents, double-click reset, keyboard steps. Whole-dB steps only (see "Values are whole numbers").                                                                                                                                       |
| `parameter-slider`                       | Adopt (S2)                   | Microphone Sync (ms)                        | A time parameter wants a typed field, scrub, reset and a description line, which is exactly this component.                                                                                                                                                                                |
| `channel-toggle` (`MuteToggle`)          | Adopt (S2)                   | Microphone Mute                             | A pressed mute reads at a glance down the strip; a switch reads like a setting.                                                                                                                                                                                                           |
| `pan-control`                            | **D1**, default not now      | Microphone pan, System audio balance        | There is no pan to control. The backend folds the microphone to centred mono on purpose and writes it to both channels; System audio keeps its stereo image. A pan slider with nothing behind it is a fake control and will not ship. Real pan is Phase P: about 1 to 2 days of backend work. |
| `volume-control`                         | **No**                       | none                                        | A 0..1 player volume with a percent readout, a perceptual curve and its own mute button. Videorc's gains are dB with boost above unity (+24 and +12 dB), mute is per channel, and there is no player. It would put percent next to dB on one panel.                                       |
| `channel-strip`, `mixer`                 | Adopt again, Sources only    | Body of the "Audio mixer" panel             | The grid that makes the controls read as a console, stacking below 36rem, with keyboard moves between strips. Removed from the Studio on 2026-10-02 (owner call) and staying out of it.                                                                                                     |
| `level-meter` (installed by 092)         | Reuse                        | Each strip's meter                          | Same meter and the same feed as the Studio Microphone section.                                                                                                                                                                                                                             |
| `SoloToggle`                             | No                           | -                                           | Solo needs a monitor bus; there are two channels and no monitoring.                                                                                                                                                                                                                        |
| `MonitorToggle`                          | Later                        | -                                           | Hearing yourself needs a new low-latency output path straight from capture (the bus runs 150 ms behind). None exists.                                                                                                                                                                      |
| `knob`                                   | No                           | -                                           | Nothing here is a trim, and a rotary control is worse than a fader in keyboard-first dense rows.                                                                                                                                                                                         |
| `MixerMaster` (a Mix strip)              | No                           | -                                           | The owner removed the Mix strip on 2026-10-02.                                                                                                                                                                                                                                             |
| `ChannelStripIcon`, `ChannelStripStatus` | No (parts)                   | -                                           | The icon paints a `bg-background` tile with a shadow; the status tints its badge. Same reasons as 092. Icons stay inline and the state is plain secondary text.                                                                                                                             |
| `ChannelStripNotice`                     | No (part)                    | -                                           | Its warning and default variants tint their background. Videorc's text-only warning lines stay.                                                                                                                                                                                            |
| `audio-device-select`                    | No (unchanged)               | -                                           | `SourceSelect` stays the one picker.                                                                                                                                                                                                                                                       |

## Verified facts (2026-10-02)

### Sources today

`apps/desktop/src/renderer/src/components/tabs/sources-tab.tsx` at `7b185ccd`
(renderer paths below are relative to `apps/desktop/src/renderer/src/`):

- The "Audio mixer" `PanelSection` (lines 424-606) holds, in order:
  - the microphone `SourceSelect`;
  - `MicPickerPreview`, the scrolling waveform (in the owner's screenshot an
    empty box with a short dotted idle line at its right edge);
  - a row that repeats the device name beside a speaker icon (448-455);
  - a boxed card (`rounded-row border bg-foreground/[0.03]`, 456) with the
    Mute `Switch`, the Gain `PowerSlider` (bipolar, number box, −24..+24),
    the Sync `PowerSlider` (−1000..+1000 ms, large step 5) and the
    calibration row (status badge, Stimulus, Import JSON, Apply, Reset, a
    message, and two `pnpm measure:av-sync` lines).
- `SystemAudioSettings` (612-710) is a second boxed card: the switch and
  state label, the explanation, the echo guard `Switch`, the Level
  `PowerSlider` (−24..+12, default −6) and the issue lines.
- Boxed cards contradict design v2: "Lists, not card stacks"; cards are only
  for objects with a picture.
- Sources is the only home of these controls: nothing else renders
  `microphoneGainDb`, `microphoneMuted` or `systemAudioGainDb` controls
  (`rg` over `components/` and `hooks/`).

### What reaches the backend, and when

- Every slider tick calls `setCaptureConfig` (`PowerSlider` has no
  `onCommit` here). `LatestWinsLiveAudioProcessingQueue`
  (`lib/live-audio-processing.ts:51-141`) sends `audio.processing.update`
  with one request in flight; newer edits fold into one pending request.
- **Live in a session:** microphone gain and mute, System audio gain, On/Off
  and echo guard (`AudioProcessingUpdateParams`,
  `crates/videorc-backend/src/protocol.rs:1244-1259`).
- **Start only:** the Sync offset, split once at session start
  (`recording.rs:17589-17625`, `session_audio.rs:2924-2970`). It is not a
  field of the live update.
- `captureConfig` is written to `localStorage` on every change
  (`hooks/use-studio.tsx:5418-5423`).

### Values are whole numbers

`normalizeAudioSettings` clamps every audio number through `clampNumber`,
which rounds (`lib/capture.ts:2733-2740`). A 0.5 dB fader value would live
for the session and snap on the next launch. So both faders use `step={1}`
and `fineStep={1}` (no Alt sub-steps), and Sync steps 1 ms. Changing the
stored resolution is out of scope.

### The audio path (for D1)

- The bus is 48 kHz, stereo, interleaved f32 (`audio.rs:19-20`); FFmpeg reads
  and writes 2 channels.
- The microphone is folded to mono by `centered_voice_sample` (averages L and
  R when both carry signal, otherwise takes the live side) and written to both
  channels (`audio.rs:872-905`, `1080-1092`; tests at `2086-2125`).
- System audio keeps its stereo image (`system_audio_capture.rs:172-225`).
- `mix_chunk` = folded microphone + System audio × gain, then a stereo-linked
  limiter (`session_audio.rs:2888-2922`).
- No pan, balance or width exists anywhere in the audio path. No monitoring
  output exists (CoreAudio is input only; the renderer `AudioContext` is never
  connected to a destination).
- Gain and mute share one `AtomicU64` (`audio.rs:150-197`).

### Meter feeds

- **Microphone:** `backendLevelSources.microphone` carries the warm
  microphone's standby level between sessions and the bus level during one,
  about 20 Hz, gain applied (plan 092). `micMeterInput`
  (`components/studio/microphone-section.tsx`) already picks between it, the
  renderer analyser and the 1 Hz session value.
- **System audio:** `backendLevelSources.systemAudio` exists only while the
  session bus runs. Between sessions nothing measures it, and a source there
  reads silence, which would be a lie. `view.meter` alone is not the gate: it
  is true outside a session whenever System audio is requested
  (`lib/system-audio.ts:100-113`, `mixed = confirmed ?? requested`).

### audiocn.dev today

- `https://audiocn.dev/r/{name}.json` answers 308 to
  `https://www.audiocn.dev/r/{name}.json`. Confirm the shadcn CLI follows it
  in S1 (`--dry-run`).
- It serves audiocn main `f53bfe6`: the served `fader.tsx` is byte-identical
  to main, `core.json` still holds the em dash in `formatDb(NaN)`, and
  `level-meter.json` still calls `toSorted`. PR #2 (the 092 U1 fixes that
  Videorc vendored from a local build of `d4dfc0a`) is open; so is PR #3
  (live-waveform scrolling).
- So installing `fader` today would offer to overwrite Videorc's U1 copies of
  `lib/audio/*` with the unfixed ones. That is why S0 comes first.
- The new control files are clean for Videorc's gates: no ES2023 API, no em
  dash, no `cursor-pointer`, no backdrop blur. Plan 092's install spike
  type-checked and linted `fader`, `parameter-slider` and `channel-toggle`
  inside Videorc. `pan-control` was not in that spike.

### Theme conflicts, and the Videorc skin

Vendored files stay pristine. Videorc styles them from the outside, with
`className` on the parts it renders:

| audiocn default                                                                  | Videorc rule                                         | Override                                                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Fader, ParameterSlider and Pan thumbs `bg-background ring-foreground/15`          | Slider thumbs are `bg-knob ring-knob-ring` (`ui/slider.tsx`); `--background` is a translucent coat | `FaderThumb className="bg-knob ring-knob-ring"`; on `ParameterSlider`: `[&_[data-slot=parameter-slider-thumb]]:bg-knob [&_[data-slot=parameter-slider-thumb]]:ring-knob-ring` |
| `ChannelStrip` default variant `bg-muted/40 rounded-xl p-3`                       | Sections are flush; no boxes                          | `variant="ghost" className="px-0 py-2"`; hairlines between groups                                           |
| `ChannelToggle` `rounded-lg`                                                      | Controls are `rounded-chip` (6 px), 28 px tall        | `className="rounded-chip"` at the default size (`h-7`)                                                      |
| `MixerChannels` scrolls (`overflow-y-auto`)                                       | Only `PaneBody` scrolls                               | `scrollable={false}`                                                                                        |
| `ChannelStripNotice` tinted                                                       | Never tint panels                                     | Not used                                                                                                    |

### Contracts the change must keep

- `scripts/perf-idle-probe.mjs:757-790` (`ensureStudioMicVisuals`) opens
  Sources, waits for `[data-videorc-mic-preview]`, then clicks the trigger of
  the `<label>` whose text is exactly `Microphone`. Keep that label on the
  picker and put `data-videorc-mic-preview` on the microphone strip's meter.
- `data-videorc-mic-visualizer` stays on the Studio meter only (the same
  probe's Studio step).
- `data-videorc-system-audio-settings` stays on the System audio group.
- `components/tabs/sources-tab.test.ts`: the explanation copy, the Mac-only
  sentence, `aria-label="System audio"`, the echo guard's `aria-checked`, the
  disabled `role="switch"` without permission, "Needs Screen Recording
  permission", "Open Settings", "Resume", the Windows copy. One assertion
  cannot survive: `value="-6"`. A Fader's hidden input carries its 0..1
  position, so assert the value text `−6.0 dB` (audiocn `formatDb`, with the
  typographic minus) instead.
- `hooks/use-studio-context-partition.test.ts`: no new file imports
  `@/lib/mic-visual-pipeline`.
- The global shortcuts `mic-toggle` and `system-audio-toggle`
  (`lib/global-shortcuts.ts`) keep flipping the same two config fields.

### Bundle

Sources is a `React.lazy` chunk (`components/app-shell.tsx:63-64`),
prefetched at idle (172); a prefetch is not eager. Plan 092 measured
standalone gzip sizes: `fader` 17.5 KB, `parameter-slider` 25.1 KB,
`channel-strip` plus `mixer` 4.1 KB. They share Base UI's Slider, so expect
the Sources chunk to grow by roughly 30 KB gzip. Measure and record it.
Eager bytes must not move.

## Design decisions

1. **Sources is the mixer; the Studio does not change.** No IA move: every
   control keeps its one home.
2. **One group per source.** A group is the channel strip plus that source's
   settings rows (Sync and Calibrate for the microphone; the explanation and
   the echo guard for System audio). Groups are flush and split by a
   hairline (`divide-y divide-border` on `MixerChannels`, `gap-0`). The strip
   grid has a single notice area, so extra rows live in the group, not in the
   strip.
3. **The picker stays above the strips.** `SourceSelect` is the one picker,
   and the perf probe finds it by its label. The strip's title is
   "Microphone"; its description is the state (Live, Muted, Idle, or No
   microphone). No row repeats the device name.
4. **The meter shows what is recorded,** from the same feed and the same
   component as the Studio Microphone section. S2 extracts both from
   `microphone-section.tsx` so the two surfaces cannot drift.
5. **Toggle versus switch.** A `ChannelToggle` is for mix state you flip
   while live: Mute. A `Switch` is for settings: System audio On/Off (it
   starts and stops a capture and can need a permission) and the echo guard.
6. **Writes do not change.** A fader's `onValueChange` makes the same
   `setCaptureConfig` update `PowerSlider` makes today, per tick; the
   latest-wins queue already coalesces. The fader reset writes 0 dB
   (microphone) or −6 dB (System audio). The Sync reset calls
   `resetAudioSyncCalibration` (it also clears
   `microphoneSyncOffsetUserSet`), so the calibration row loses its own Reset
   button: one home per action.
7. **Honest timing.** While a session runs, Sync's description reads
   "Applies from the next recording or stream."
8. **The calibration tools fold** under "Calibrate" (D3).
9. **Videorc's skin, audiocn's files.** Overrides by `className` only (table
   above). No local edits to vendored files; a real defect goes upstream.
10. **Lazy stays lazy.** The new components are imported only from the
    Sources chunk. Base UI's ESLint fence grows by exactly the new audiocn
    files.
11. **Keyboard-first, quietly.** The mute toggle and the System audio switch
    show their bound global shortcut (`micToggle`, `systemAudioToggle`) as a
    `Kbd` chip in their tooltip when one is set, and nothing when none is.

## Owner decisions (recommended defaults; S0 to S4 can start on them)

- **D1. Pan (Phase P).** Recommended: **not now.** The microphone is centred
  mono on purpose: a voice belongs in the middle, and the fold rescues
  interfaces that carry the mic on one side only. Streamers almost never pan
  a voice, and System audio already keeps its stereo image. A Pan that moves
  nothing will not ship. Yes means Phase P: a real pan on the microphone and
  a balance on System audio, live in a session, about 1 to 2 days of backend
  work plus the recording gates. S2 and S3 leave a row for it.
- **D2. Volume control.** Recommended: **no** (reasons in the table). There
  is no honest home for it today; the faders do the volume job in dB.
- **D3. Calibration tools.** Recommended: fold them under a closed
  "Calibrate" disclosure (shadcn `Collapsible`). The status badge, Import
  JSON, Apply and the message stay in every build. The Stimulus button and
  its two `pnpm measure:av-sync` lines render only in development builds
  (`import.meta.env.DEV`): a packaged app has no pnpm. Alternative: leave
  everything open, as today.
- **D4. System audio meter between sessions.** Recommended: keep the meter
  row, at rest with no reading, titled "Shows while recording or live", so
  nothing shifts when a session starts. Alternative: hide the meter row until
  a session mixes System audio.

## Slice S0 (audiocn repo): ship PR #2 to audiocn.dev

Work in `~/projects/audiocn` on its own worktree; other sessions use that
checkout. Merging audiocn PRs is the owner's call (plan 092 left it owed);
get the owner's go before merging.

1. Rebase `fix/videorc-adoption` (head `d4dfc0a`) onto `origin/main`
   (`f53bfe6`). Expect a conflict in `components/ui/level-meter.tsx` with
   `e37e50c` (dB readout vertically centred): keep both changes.
2. Run audiocn's gates: `pnpm test`, `pnpm typecheck`, `pnpm check`,
   `pnpm build`. `pnpm test:install` cannot run on this Mac (pnpm trust
   policy, `undici-types@6.21.0`); say so in the PR.
3. Merge, let it deploy, then verify what the site serves (follow the
   redirect, `curl -sL`):
   - `core.json` holds no U+2014 and does hold `createFrameTask` (the settle
     loop);
   - `level-meter.json` holds no `toSorted`;
   - `fader.json`, `parameter-slider.json`, `channel-toggle.json`,
     `channel-strip.json`, `mixer.json` answer 200.

**Done when:** audiocn.dev serves merged main, and its commit is written into
this plan's execution notes.

## Slice S1: vendor the controls, no visible change

**Files:** `apps/desktop/package.json` and `pnpm-lock.yaml` only if the CLI
changes them; new `components/ui/channel-strip.tsx`, `mixer.tsx`,
`fader.tsx`, `parameter-slider.tsx`, `channel-toggle.tsx`; any already
vendored audiocn file the CLI updates (S0 brings upstream changes since
`d4dfc0a`); `styles.css`; `eslint.config.mjs`; `audiocn-adoption.test.ts`;
`docs/audiocn.md`; `.claude/skills/videorc-design/SKILL.md`.

1. From `apps/desktop`:
   `pnpm dlx shadcn@4.21.1 add @audiocn/channel-strip @audiocn/mixer @audiocn/fader @audiocn/parameter-slider @audiocn/channel-toggle --dry-run --diff`.
   Read every diff. An existing audiocn file may change only by upstream
   changes made after `d4dfc0a`; anything else is a STOP.
2. Install. The CLI asks per colliding file and ignores piped answers, so do
   what 092 did: install with `--overwrite`, then restore
   `components/ui/badge.tsx` and `styles.css`
   (`git checkout -- <path>`), and remove the `cn` package if the CLI added
   it, then `pnpm install`. Keep `@base-ui/react` (already a dependency).
3. **Tokens.** Put the channel tokens back by hand (092's values; they left
   with the channel strip on 2026-10-02), on `:root, .dark` beside the meter
   block: `--channel-mute: var(--warning)`, `--channel-solo:
   var(--foreground)`, `--channel-monitor: var(--info)`, and the three
   `*-foreground` tokens with the same values; plus the six `--color-channel-*`
   lines in `@theme inline`. Extend `audiocn-adoption.test.ts` to cover them
   (each aliases a Videorc token; no colour literal; no self-reference).
4. **ESLint fence.** Add `channel-strip.tsx`, `fader.tsx`,
   `parameter-slider.tsx` and `channel-toggle.tsx` to
   `AUDIOCN_BASE_UI_FILES`. `mixer.tsx` does not import Base UI.
5. `pnpm exec prettier --write` on the new and changed files.
6. **`docs/audiocn.md`:** the installed table (the new items, home "Sources
   Audio mixer"), the audiocn commit, the update command with the new item
   list, the skin overrides table from this plan, and a rewritten "Not
   adopted" list (`pan-control` pending D1, `volume-control`, Solo, Monitor,
   `knob`, Mix strip, the blocks, the Web Audio hooks), linking this plan.
7. **Design skill.** In the component mapping, next to "Audio levels", add
   "Audio controls | audiocn `Fader`, `ParameterSlider`, `MuteToggle` in
   `ChannelStrip`s, on the Sources Audio mixer only (`docs/audiocn.md`);
   `PowerSlider` everywhere else". Add one Don't: never ship a pan, solo,
   monitor or volume control without a backend path behind it.

**Verification:**

```sh
pnpm typecheck
git add -A && pnpm lint   # the em-dash gate reads git ls-files
pnpm format:check
pnpm --filter @videorc/desktop test
pnpm build && pnpm check:renderer-assets
```

**Done when:** gates are green; nothing imports the new components yet;
eager raw bytes equal main's within noise (compare raw, not gzip: a Mac reads
about 1.6 KB of gzip above CI).

## Slice S2: the Microphone strip

**Files:** new `components/sources/sources-audio-mixer.tsx` (the panel body,
imported only by `sources-tab.tsx`); new `components/studio/mic-level-meter.tsx`;
`hooks/use-studio-mic-sources.ts` (add `useMicrophoneMeter`);
`components/studio/microphone-section.tsx` (uses the two extractions, no
visual change); `components/tabs/sources-tab.tsx`; tests.

1. **Extract, do not copy.**
   - `useMicrophoneMeter()` in `hooks/use-studio-mic-sources.ts` (a module
     only lazy chunks import) returns `{ meter: MeterInput, monitorLabel }`,
     built exactly as `MicrophoneSection` builds them today.
   - `MicLevelMeter` renders the `LevelMeter` branch (a live source with
     `peak` ballistics, or one value with `vu` ballistics), passing data
     attributes through.
   - `MicrophoneSection` switches to both; its tests pass unchanged.
2. **Panel.** Keep the `PanelSection` title "Audio mixer" and its icon. New
   description (owner by-eye): "What your recording and stream hear, after
   gain. Nothing is processed automatically." The microphone `SourceSelect`
   stays first, unchanged. Remove `MicPickerPreview` and the name row from
   Sources; Quick Settings keeps `MicPickerPreview`.
3. **Mixer.** `<Mixer minDb={-60} maxDb={0}>` with an `sr-only`
   `MixerTitle` ("Audio mixer"), then
   `<MixerChannels scrollable={false} className="gap-0 divide-y divide-border">`.
4. **Microphone group** (`div`, `role="group"`, `aria-label="Microphone"`):
   - `ChannelStrip variant="ghost" className="px-0 py-2"`, `muted` from the
     config, `dimmed` when no microphone is selected.
   - **Header:** `MicrophoneIcon` inline (16 px, `text-muted-foreground`),
     then `ChannelStripText` with `ChannelStripTitle` "Microphone" and
     `ChannelStripDescription` = the monitor label (Live, Muted, Idle) or
     "No microphone".
   - **Meter:** `ChannelStripMeter` with `data-videorc-mic-preview`, holding
     `MicLevelMeter variant="segmented"`.
   - **Fader:** `Fader aria-label="Microphone gain" min={-24} max={24}
     origin={0} detents={[0]} resetValue={0} step={1} fineStep={1}
     largeStep={6}`, the config value, `onValueChange` writing
     `microphoneGainDb`; children `FaderTrack` > `FaderRange` +
     `FaderThumb className="bg-knob ring-knob-ring"`.
   - **Value:** `ChannelStripValue` with `formatDb(gainDb)` from
     `@/lib/audio/decibels` (`0.0 dB`, `+6.0 dB`, `−6.0 dB`).
   - **Controls:** `MuteToggle aria-label="Mute microphone"
     className="rounded-chip"`, `pressed` = muted, `onPressedChange` writing
     `microphoneMuted`, holding `SpeakerOffIcon` when pressed and
     `SpeakerOnIcon` when not. Tooltip: "Mute microphone" plus the `Kbd`
     chip when `micToggle` is bound.
5. **Sync row** (inside the group, under the strip): `ParameterSlider
   min={-1000} max={1000} step={1} largeStep={5} unit="ms" origin={0}
   resetValue={0}`, with the thumb override on its root.
   - Header: `ParameterSliderLabel` "Sync", `ParameterSliderReset`,
     `ParameterSliderInput`; then `ParameterSliderControl`.
   - `onValueChange(value, details)`: on `details.reason === 'reset'` apply
     `resetAudioSyncCalibration` and set the message "Reset microphone sync
     to structural default."; otherwise write
     `normalizeMicrophoneSyncOffsetMs(value)` with
     `microphoneSyncOffsetUserSet: true`, as today. Put this in a pure,
     exported reducer so it is unit-tested.
   - While a session runs: `ParameterSliderDescription` "Applies from the
     next recording or stream."
6. **Calibrate** (D3): a ghost `Button size="xs"` with `ChevronRightIcon` as
   the `Collapsible` trigger, closed by default. Inside: the status badge,
   Import JSON (with its hidden file input), Apply, the message; in DEV
   builds also Stimulus and its two command lines. No Reset here.

**Tests:**

- `sources-audio-mixer.test.ts`:
  - the group is labelled "Microphone" and its meter carries
    `data-videorc-mic-preview`;
  - the mute toggle's `aria-pressed` follows the config, and the strip
    carries `data-muted` when muted;
  - the Gain value text reads `0.0 dB` and `+6.0 dB`;
  - the Sync reducer: a typed or dragged value sets `UserSet`, a reset
    clears it and restores 0;
  - the session description appears only while a session runs;
  - "Import JSON" is absent until Calibrate opens; the `pnpm` lines render
    only when `import.meta.env.DEV` is true.
- `microphone-section.test.ts` unchanged and green.
- The partition test still passes.

**Verification:** S1's commands, plus:

- `VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance`
  on main and on the branch, on the same machine: renderer CPU within 1
  percentage point. It needs a Microphone grant for the Electron binary,
  which a fresh worktree's dev binary does not have (TCC is per binary). If
  that blocks it, say so and record what ran instead.
- A live check in the dev app: start a recording, drag Gain and toggle Mute,
  and confirm the meter and the recording follow (the live-audio path is
  unchanged; this proves the wiring).
- Owner by-eye, both themes, wide and narrow.

**Done when:** gates are green, the perf comparison is in the PR, and the
owner accepts the microphone strip by eye.

## Slice S3: the System audio strip

**Files:** `components/sources/sources-audio-mixer.tsx`,
`components/tabs/sources-tab.tsx` (`SystemAudioSettings` moves or is
re-exported, so its test import keeps working), `sources-tab.test.ts`.

1. Rebuild `SystemAudioSettings` as the second group of the same `Mixer`.
   Keep its name and props; add `meter: MeterInput` and `sessionActive`.
2. **Header:** `DesktopIcon` inline, title "System audio", description
   `view.stateLabel` (Off, On, Turning on…, Turning off…, Paused).
3. **Meter:** `backendLevelSources.systemAudio` only when
   `sessionActive && view.meter` and backend levels are arriving; otherwise
   no reading (`peakDb={Number.NaN}`) and `title="Shows while recording or
   live"` (D4).
4. **Fader:** `aria-label="System audio level" min={-24} max={12}
   resetValue={-6} detents={[-6, 0]} step={1} fineStep={1} largeStep={6}`,
   fill from the bottom (no `origin`), disabled exactly when today's slider
   is (`view.permissionRequired`). Same thumb override.
5. **Value:** `formatDb(gainDb)`.
6. **Controls:** the existing `Switch` (`aria-label="System audio"`, the same
   `checked` and `disabled`), its tooltip showing `systemAudioToggle` when
   bound.
7. **Rows under the strip:** the explanation (12 px secondary, copy
   unchanged, the Mac sentence on macOS only), the echo guard row (unchanged
   `Switch`), and the issue lines (unchanged text, `text-warning`, with
   Open Settings or Resume).
8. `data-videorc-system-audio-settings` on the group. The group renders
   only when `view.visible`, as today.

**Tests:** `sources-tab.test.ts` keeps every assertion except `value="-6"`,
which becomes the value text `−6.0 dB`. Add: outside a session the meter
row is present with no reading; with `sessionActive` and `view.meter` it
takes the backend source.

**Verification:** S1's commands; owner by-eye of off, on with no session, on
in a session (moving meter), turning on and off, echo paused with Resume,
permission missing, and narrow width. Windows copy stays covered by the
render test.

**Done when:** gates are green and the owner accepts the System audio strip
by eye.

## Slice S4: acceptance record, index, release note

1. `docs/acceptance/2026-10-XX-sources-audio-mixer.md`, the owner checklist:
   - a packaged build, both themes, wide and narrow Sources;
   - a keyboard walk: Tab order; arrows, Shift+arrows, Home/End and
     double-click reset on each fader; Cmd/Ctrl+Up and Down between strips;
     typing and scrubbing Sync;
   - a live session: Gain, Mute, Level, On and the echo guard apply live;
     Sync shows its note;
   - VoiceOver names: "Microphone gain", "Mute microphone", "System audio
     level", "System audio", "Sync".
2. Record the Sources chunk size before and after, and the eager raw delta.
3. `plans/README.md` row; release note: "Sources: the Audio mixer is now a
   console: faders, a mute button and a precise Sync control."

**Done when:** the record exists and the plan's execution notes are filled
in.

## Phase P (D1 = yes): real pan and balance

Only on the owner's yes. Recording-output work: own commits, own gates.

- **Fields.** `microphonePan` and `systemAudioBalance`, whole percent from
  −100 to +100, default 0. Whole numbers because the renderer's
  normalisation rounds.
- **Law.** Centre must stay bit-identical to today's output. Use a balance
  law per channel, `L × min(1, 1 − p)` and `R × min(1, 1 + p)` with
  `p = percent / 100`, applied after the microphone's mono fold and on
  System audio's stereo pair. Not constant-power: that law is −3 dB per side
  at centre and would change the level of every existing setup.
- **Where.** `mix_chunk` and the microphone-only writer
  (`session_audio.rs:2898`, `4717`). The captions and level tap stays before
  the pan (`session_audio.rs:4505-4522`), so a hard-panned microphone is not
  6 dB quieter to captions.
- **Live.** A separate atomic read on every bus write, like gain; do not
  repack the gain and mute `AtomicU64`.
- **FFmpeg-owned microphone paths** (Linux Pulse, the Windows dshow
  fallback) apply pan at session start through the existing `pan=stereo`
  filter; a live change there waits for the next session, and the UI says so
  on those platforms.
- **Contract.** Rust `protocol::AudioSettings` with `#[serde(default)]`;
  `AudioProcessingUpdateParams` fields as `Option` with
  `#[serde(default, skip_serializing_if = "Option::is_none")]` (the
  serde-null trap has broken app load three times); TS types in
  `shared/backend.ts`; defaults and normalisation in `lib/capture.ts`; the
  queue fields in `lib/live-audio-processing.ts`; the effect dependencies
  and the start snapshot in `hooks/use-studio.tsx`.
- **UI.** Install `@audiocn/pan-control` and add it to the Base UI fence. A
  "Pan" row in the microphone group and a "Balance" row in the System audio
  group: `PanControl size="sm"` with its centre detent and double-click
  centre, the `formatPan` text (L30, C, R30), the thumb override.
- **Gates:** targeted `cargo test -p videorc-backend` for the audio and
  session_audio modules (centre bit-identical, including the existing tests
  at `audio.rs:2086-2125`; hard left silences R; the captions tap stays
  pre-pan; a live update applies) plus `cargo clippy -p videorc-backend -- -D
  warnings` and `cargo fmt --check --all`; contract tests (no `null`);
  `pnpm smoke:recording-studio`; `pnpm smoke:system-audio`; a headphone
  listen test on a packaged build.

## Edge cases

- **No microphone:** the strip is dimmed and says "No microphone"; the meter
  has no reading; the fader and mute still set the saved values (today's
  behaviour).
- **Muted:** audiocn dims the strip, the meter reads silence, and the toggle
  is pressed (amber). The Studio sliver and the global shortcut stay in step:
  they read the same field.
- **Dragging Gain or Level live:** per-tick writes, coalesced by the queue,
  as today.
- **Sync during a session:** saved at once; applied at the next start; the
  description says so.
- **System audio without permission:** the switch, the fader and the echo
  guard are disabled; the warning line offers Open Settings.
- **Echo pause:** the description reads "Paused"; the Resume line shows.
- **Narrow pane:** strips stack by container query; no horizontal scroll.
- **Light theme:** token aliases resolve per theme; thumbs are the white
  knob with its ring.
- **Reduced motion:** audiocn meters update at 4 Hz without ballistics.
- **Windows and Linux:** the System audio group is hidden where
  `view.visible` is false; the microphone strip is identical.
- **Device switch:** the picker's pending state is unchanged; the meter keeps
  its subscription.
- **StrictMode:** no extra retains of the microphone pipeline (092's
  adapters).

## STOP conditions

1. **S0 is not live on audiocn.dev.** Do not install, and never patch a
   vendored file locally.
2. **The CLI wants to write outside a slice's file list,** or to replace
   `badge.tsx` or keep its CSS. Stop and read `--dry-run --diff`.
3. **Eager raw bytes move** beyond noise. Something in the entry graph
   imports audiocn; look at `use-studio-mic-sources.ts` imports first.
4. **Renderer CPU regresses** by more than 1 percentage point with a live
   microphone on Sources.
5. **A slice outside Phase P needs a backend, capture or session change.**
6. **A control would ship with nothing behind it** (pan without Phase P,
   solo, monitor, a volume control).
7. **The owner rejects a strip at a by-eye.** Stop and ask; do not iterate
   on taste alone.

## Out of scope

- The Studio (it keeps the Microphone section only).
- `PowerSlider` on Layout and Assets.
- Monitoring (hearing yourself), Solo, a Mix strip.
- The stored resolution of audio values.
- Windows System audio (#478).
- Quick Settings (it keeps `MicPickerPreview`).
- The phone remote page.

## How to start

- S0 first, in audiocn, with the owner's go to merge.
- Then work in the Videorc worktree `../videorc-wt-093` (branch
  `plan/093-sources-audio-controls`, which carries this plan). Never use the
  shared checkout: other sessions switch its branch.

  ```sh
  git -C ../videorc-wt-093 fetch origin && git -C ../videorc-wt-093 rebase origin/main
  pnpm install --frozen-lockfile --prefer-offline
  ```

- One Videorc PR for S1 to S4, one commit per slice. Phase P is its own PR.
- Record in the execution notes: the audiocn commit installed, the eager raw
  delta, the Sources chunk delta and the perf numbers.

## Execution notes

### What was done (2026-10-02)

- **S0:** audiocn's gates ran green on the merge PR #2 will produce (main
  `f53bfe6` + `d4dfc0a`, built locally as `136c574`): 321 tests, typecheck
  (after `next build` writes `next-env.d.ts`), Ultracite, `next build`. The
  merge itself was refused by this session's permission rules, so it is the
  owner's to do.
- **S1** `d8f6ecc9`: `channel-strip`, `mixer`, `fader`, `parameter-slider`,
  `channel-toggle` installed from that local registry build. Every shared
  file (`lib/audio/*`, `use-audio-config`, `db-scale`) came out
  byte-identical to the plan 092 copies after Prettier. Channel tokens back;
  Base UI fence; docs and the design skill. Eager raw unchanged.
- **S2** `33a541b4`: the microphone strip, Sync on the parameter slider,
  Calibrate. `useMicrophoneMeter` and `MicLevelMeter` are shared with the
  Studio Microphone section.
- **S3** `b41e6eed`: System audio as the second strip, its meter fed by the
  bus only while a session mixes it.
- **By-eye fix** `a0696fa4`: dead space around the strips (the Mixer grid's
  gaps around unused rows).
- **S4:** `docs/acceptance/2026-10-02-sources-audio-mixer.md`, this section,
  the index row.
- **Review fixes** `0b552fe8` (a read-only review of the branch): the shortcut
  tooltip's Radix trigger overwrote the System audio Switch's `data-state`,
  so On and Off drew the same track; a Sync reset left Calibrate's last
  "Applied ..." line; an sr-only `MixerTitle` repeated the section heading
  for screen readers. All three fixed, the first with a failing test first.

Numbers: eager raw 1,991,814 to 1,991,859 (+45, the entry's lazy chunk map);
Sources chunk 9.8 to 45.8 KB gzip; 2,545 desktop tests green.

### Deviations from the plan, and why

1. **Installed from a local build, not audiocn.dev** (STOP 1). The merge of
   PR #2 was not this session's to make, and audiocn.dev still serves the
   pre-U1 files. The installed files are what the merge will serve, byte for
   byte after Prettier; no local patches.
2. **The waveform preview and `live-waveform` are deleted, not kept.** The
   plan said Quick Settings keeps `MicPickerPreview`; it does not use it.
   Sources was its only user, so the component and the vendored file went
   with it. Its plan 080 copy moved to `lib/mic-meter-input.ts` as
   `micLevelUnavailableCopy` ("level" for "preview"), still shown when no
   live level reads.
3. **Accessible names.** The meters are "Microphone level" and "System
   audio level", so the faders are "Microphone gain" and "System audio
   gain" (the plan had "System audio level" for both).
4. **The strip's state line** is the monitor label the Studio section
   already computes (Live, Monitoring, Muted, Idle), plus "No microphone".
5. **`sources-tab.test.ts` moved** to
   `components/sources/sources-audio-mixer.test.ts` with the component.
6. **Perf probe:** `smoke:preview-performance` with the mic visuals fails
   identically on the branch and on main in fresh worktrees (no Microphone or
   Screen Recording grant for their binaries: no selectable microphone, no
   preview frames), so no CPU comparison could be made here; it is owed on a
   granted build (acceptance record).

### Owed

- Merge audiocn PR #2, then check the five new files against audiocn.dev and
  record the merge commit in `docs/audiocn.md`.
- The owner checklist in the acceptance record (packaged build, live mic).
- D1 (pan) and D2 (volume) answers; Phase P only on a yes.
