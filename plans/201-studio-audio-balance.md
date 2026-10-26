# Plan 201: balance the Microphone and System audio from the Studio

**Status:** PLANNED 2026-10-26. Nothing is built; this file is the only
change. **Priority:** P2. Owner request: "inside of our studio, a meter for
system audio as well and we need a volume meter for system audio and for the
microphone so people can balance it out, we can use audiocn for that one for
volume control." **Size:** M: one verification slice (S0), one renderer logic
slice (S1), two UI slices (S2 default look, S3 Retro LCD look) and one
acceptance slice (S4). No backend change. **Planned against:** Videorc
`origin/main` `0438849f` (the shared checkout is 669 commits behind on
`feat/windows-owner-waiver`, so every reference below is from an
`origin/main` export; work in a fresh worktree). **Owner route:**
Orchestrator planned it (fit 10). S0 and S1: Implementation (fit 8), lane
`gpt-5.5`. S2 and S3: UI/Product Design (fit 9), lane `opus-4.8`, with the
whole `.claude/skills/videorc-design/SKILL.md` read first. S4:
Implementation (fit 7), lane `gpt-5.5`.

## Goal

From the Studio, without opening Sources, a streamer sees the Microphone
and System audio levels next to each other on one scale. Each has a Gain
fader under its meter. Dragging a fader moves its meter, so the streamer can
set their voice over game or music audio before recording or going live,
and adjust it during a session. The controls are the audiocn `Fader` that
Sources already uses, writing the same values. Nothing pretends: a meter
with no reading says when it will move.

## Owner decisions (2026-10-26)

- **D1. Placement: one Audio section.** The Studio's Microphone section
  becomes **Audio**, with a Microphone row and a System audio row. The
  System audio switch moves into it from the Studio's Sources mirror, which
  keeps Screen and Camera. This reverses the 2026-10-02 call ("the Studio
  keeps the Microphone section, no mixer", plans 092 and 093). The new call
  replaces it.
- **D2. Control: the audiocn `fader` in dB,** the one Sources uses. The copy
  calls it **Gain** (`CONTEXT.md`: Gain is the fader, Level is the meter;
  "volume" is not used for a source). audiocn's `volume-control` (0 to 100%
  player volume) and `knob` stay out, for plan 093's reasons.
- **D3. Idle System audio level: from Clips only.** No new capture. The
  System audio meter reads whenever a session's audio bus is running: a
  recording, a livestream, or Clips, which is on by default. With Clips off,
  the row says when its level shows. A backend standby capture (like the
  warm microphone) is not part of this plan.
- **D4. Just two rows.** Microphone and System audio. Sounds keeps its level
  on Sources. No Mix (master) meter.

Defaults the executor applies unless the owner changes them at the by-eye
(S2 and S3):

- **D5. Retro LCD gain.** Recommended: the same audiocn `Fader`, skinned
  from outside with the LCD ink tokens and placed inside the LCD screen under
  each meter. Fallback if it reads wrong in either theme: an LCD value row
  ("Gain −6.0 dB") with step buttons, keyboard arrows and double-click reset.
- **D6. The Clips-off line.** Recommended copy: "Level shows while you
  record, go live, or keep Clips on." Check it against `docs/ui-copy.md`;
  the owner can change the words at the by-eye.

## What the user will see

Default look (the Studio inspector, between Session and Sources):

```
 Audio
   [mic]  Microphone                              [Muted]  [mute]
          [ Shure MV7+                                     v ]
          |||||||||||||||||.......................
          Gain   ------------o------------------     0.0 dB
   ---------------------------------------------------------------
   [desk] System audio                                   (On  o)
          ||||||||||..............................
          Gain   --------o----------------------    -6.0 dB
```

- **One scale.** Both meters are the same `MicLevelMeter`, inside one
  audiocn `Mixer` with Sources' range (−60 to 0 dB), so equal heights mean
  equal loudness.
- **Microphone row:** title, Muted chip and Mute with its hotkey (as today),
  the picker, the meter, then Gain (−24 to +24 dB, detent and reset at
  0 dB).
- **System audio row:** title, its state, the On switch with its hotkey
  tooltip, then, while On, the meter and Gain (−24 to +12 dB, detents at
  −6 and 0 dB, reset to −6 dB). The issue lines and their one action
  (Resume after the echo pause, Open Permissions) come with it from the
  Sources mirror. No row on Linux or on Windows builds without process
  loopback (`systemAudio.visible` is false); the section is then Microphone
  only, still titled Audio.
- **When the System audio meter moves:** during a recording, a livestream,
  or while Clips runs. With Clips off, the meter row rests and the D6 line
  sits under it. While Clips restarts (a source change restarts its ring),
  the meter rests for a moment with no line, so nothing jumps.
- **Fader to meter:** dragging Gain moves the meter, with or without a
  session (the readings are after gain). The Microphone meter already did
  this; the System audio meter now does too.
- **Sources mirror** in the Studio: Screen and Camera, with Open Sources.
- **Retro LCD look:** the same section on one LCD screen: the Microphone
  rows (as today), a dotted separator, the System audio rows, each with its
  LCD meter (no printed scale) and Gain per D5.
- **Unchanged:** every value, range, default and where it is stored; Sources
  (except that its System audio meter now also moves while Clips runs, from
  S1); the global shortcuts `mic-toggle` and `system-audio-toggle`; the
  session mic sliver; the soundboard.

## Verified facts (origin/main `0438849f`)

Renderer paths are under `apps/desktop/src/renderer/src/`.

### The Studio today

- `components/tabs/studio-tab.tsx:241-252`: the inspector renders Session,
  then the lazy `MicrophoneSection` (`:56-57`, fallback skeleton `:273-287`),
  then `QuickSettings` or `RetroQuickSettings`, then the Takeover section.
- `components/studio/microphone-section.tsx`: picker, `MicLevelMeter`, Mute
  in the header. No Gain control. Probe contracts on it:
  `data-videorc-mic-level`, `data-videorc-mic-visualizer`,
  `data-videorc-studio-mic-mute`, `data-videorc-mic-monitor-state`
  (`scripts/perf-idle-probe.mjs` reads the visualizer and the monitor state).
- `components/studio/quick-settings.tsx:131-145`: the System audio row is a
  switch with a status (`SystemAudioInspectorValue`, `:176`). No meter, no
  Gain. `useStudioSources` (`:264-309`) builds the view with
  `sessionActive: isSessionActive`.
- `components/studio/retro-lcd-studio.tsx`: `RetroMicrophoneSectionView`
  (`:291`), `RetroQuickSettings` (`:405`, System audio at `:480-490`),
  `RetroSystemAudioValue` (`:535`).
- Design skill, "Where things live": Sources is the home of every source with
  its gain and level; the Studio mirrors a few. A mirror that edits the same
  state is allowed. The shadcn mapping row "Audio controls: audiocn controls
  in Sources rows" changes in S4.

### Sources already has the controls

`components/sources/sources-audio-mixer.tsx`:

- One audiocn `Mixer minDb={-60} maxDb={0}` around the rows (`:221`).
- `MicrophoneChannel`: `Fader` −24..+24, detent 0, `step={1}`,
  `fineStep={1}`, `largeStep={6}`, `origin={0}`, in a `SourceControlRow`
  labelled Gain with a reset readout (`gainReset`).
- `SystemAudioSettings`: `Fader` `SYSTEM_AUDIO_GAIN_DB_MIN..MAX`, detents
  `[SYSTEM_AUDIO_GAIN_DB_DEFAULT, 0]`, disabled while permission is missing;
  while no reading, the line "Level shows while recording or live."
- `FADER_THUMB = 'bg-knob ring-knob-ring'` styles audiocn's thumb from outside
  (vendored files stay pristine, `docs/audiocn.md`).
- Every fader tick calls `setCaptureConfig`; values are whole dB because
  `normalizeAudioSettings` rounds (plan 093, "Values are whole numbers").

### Where the levels come from

- `hooks/use-studio-mic-sources.ts:50-55`: `backendLevelSources` (microphone,
  systemAudio, sounds, master) over `backendAudioLevels`, which is live while
  `audio.levels` events keep arriving (`lib/backend-audio-levels.ts`, stale
  after 1,000 ms).
- `crates/videorc-backend/src/recording.rs:6815-6823`: every session with a
  bus spawns `stream_audio_levels_during_recording` (`:9940`), **including a
  buffer-only Clips session**; only the soundboard handle is skipped for one.
- `recording.rs:6915-6929`: `request_initial_system_audio` opens System audio
  for any session with the switch On, Clips included (only the performance
  check is excluded).
- `lib/capture.ts:1451`: `replayBuffer: { enabled: true, explicit: false }`.
  Clips is on by default, and `CONTEXT.md` defines it as running "whenever
  Videorc is open".
- **The gap:** `lib/mic-meter-input.ts:55-65` `systemAudioMeterInput` returns a
  reading only when `sessionActive && mixed && backendLevelsLive`, and
  `sessionActive` is `isSessionActive`, which is false for a Clips ring
  (`shared/capture-state.ts:92-101`, `sessionOwnsTransport` excludes
  `replayOnly`). `lib/system-audio.ts` `systemAudioSwitchView` likewise takes
  its idle branch (no meter, no issue, no pending) while only Clips runs.
- **Gain reaches the Clips bus live.** `use-studio.tsx` (around `:11740`)
  syncs gain, mute and the System audio fields through
  `activeAudioProcessingUpdateParams` (`lib/live-audio-processing.ts:167-179`),
  which keys on `state` in recording/streaming and a session id. A Clips ring
  reports `state: 'recording'` with `replayOnly: true`
  (`lib/studio-session-view.test.ts:52`), so it qualifies.
  `mixingSessionActive` and `systemAudioConfirmed` (`use-studio.tsx:11462-11464`)
  also cover the ring.
- **Microphone, Clips off:** the warm microphone's standby levels (macOS
  CoreAudio, gain applied, re-armed on every Gain change,
  `hooks/use-studio-mic-visual.tsx:94-116`) or the renderer analyser
  (gain read every frame). The Microphone meter already follows its fader
  in every state.

S0 confirms the code reading above against the running app before anything
is built on it.

### Bundle

The Studio's Microphone section is a lazy chunk; `Fader` already ships in the
lazy Sources chunk. Eager bytes must not move: `pnpm check:renderer-assets`
(main had a few hundred gzip bytes of headroom at plan 196).

## Slice S0: prove the idle data path (no product change)

**Why first:** D3 rests on two code-reading claims: a Clips ring sends
`systemAudio` levels, and a Gain change reaches the ring's bus. If either is
false, the plan stops here.

**Files:** `scripts/smoke-system-audio-app.mjs` (one new case),
`scripts/lib/system-audio-gates.mjs` and its test (a pure gate for the case).

**Changes:** add a case `clips-idle`:

1. Seed Clips on (`replayBuffer: { enabled: true, explicit: false }`, as
   `smoke-replay-buffer-app.mjs:144` does) and System audio On. Do not
   record.
2. Wait for `recording.status` with `replayOnly: true`.
3. Play the 1 kHz `afplay` tone at 2 to 5 s. Collect every `audio.levels`
   event on the renderer socket.
4. At 3.5 s send `systemAudioGainDb` −18 through the same renderer path the
   fader uses (a smoke hook or a remote intent, whichever already exists; do
   not add a new backend route).
5. Gate (pure, unit-tested): `systemAudio` readings exist while the tone
   plays; their peak drops by 12 dB ± 2 dB after the gain change (−6 → −18);
   readings fall to the floor after the tone; every event carries the ring's
   session id.

**Verification:** `pnpm test:scripts`; `pnpm smoke:system-audio` on a Mac with
the dev app's Screen Recording grant (it SKIPs explicitly without it, per its
header; record the SKIP and get the run from the owner's machine).

**Done when:** the case passes on macOS and its output is pasted into this
plan's execution notes.

**STOP** if the ring sends no `systemAudio` readings, or the gain does not
move them. Report what `audio.levels` carried; the fix is then backend work
(D3's alternative, standby capture) and needs a new owner decision.

## Slice S1: the meter follows any running bus (renderer logic)

**Files:** `lib/mic-meter-input.ts`, `lib/system-audio.ts`,
`hooks/use-studio.tsx` (expose one boolean), `components/sources/sources-audio-mixer.tsx`
(call site), `components/studio/quick-settings.tsx` (`useStudioSources` call
site), tests next to each.

**Changes:**

1. Expose `audioBusActive` from the Studio core context: `mixingSessionActive`
   (a recording, a livestream, or a Clips ring). Do not change
   `isSessionActive`; every page that locks for a session keeps its meaning.
2. `systemAudioSwitchView` takes `audioBusActive` and uses it, instead of
   `sessionActive`, for the branch that reads `confirmed`, `pending`, `issue`
   and `meter`. A Clips ring then shows Turning on…, Paused (the echo guard)
   and the lost state like a session does. Keep `sessionActive` in the input
   for anything that means "recording or live".
3. `systemAudioMeterInput` becomes
   `{ audioBusActive, mixed, backendLevelsLive, source }`: a reading when the
   bus runs, System audio is mixed with no change pending, and levels are
   live.
4. New pure helper `systemAudioIdleReason({ audioBusActive, clipsArmed,
   clipsState, checked })`: `'clips-off'` when System audio is On, no bus
   runs and Clips is off or gave up; `null` otherwise (including Clips
   starting or restarting). S2 shows the D6 line for `'clips-off'` only.
5. Sources passes `audioBusActive`. Its meter now moves while Clips runs;
   its idle line keeps its slot. Update its copy to the D6 line so both pages
   say the same thing.

**Tests:**

- `systemAudioMeterInput`: reading for a recording, a livestream and a Clips
  ring; none with Clips off, while pending, with stale levels, or Off.
- `systemAudioSwitchView`: the ring branch shows pending, Paused and lost;
  idle with no bus is unchanged.
- `systemAudioIdleReason`: each case above.
- Existing `sources-tab` / `sources-audio-mixer` assertions keep passing,
  except the updated idle copy.

**Verification:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`, and the remote-control projection
tests unchanged.

**Done when:** gates pass and, in the dev app with Clips on and System audio
On, the Sources System audio meter moves to music while idle.

**STOP** if exposing `audioBusActive` changes any remote-control or Stream
Deck projection test, or needs an edit inside the live audio processing sync
effect. That path is recording-studio territory (AGENTS.md); report instead.

## Slice S2: the Studio Audio section (default look)

Read `.claude/skills/videorc-design/SKILL.md` in full first.

**Files:**

- `components/studio/microphone-section.tsx` becomes
  `components/studio/audio-section.tsx` (`git mv`, then `AudioSection`,
  `AudioSectionView`); `microphone-section.test.ts` follows it.
- New `components/audio/gain-faders.tsx`: `MicrophoneGainFader` and
  `SystemAudioGainFader` (the `Fader` with its range, detents, steps, reset,
  `FADER_THUMB`, aria-label, inside a `SourceControlRow` labelled Gain), plus
  `gainReset` moved from Sources. Sources imports them, so the two pages can't
  drift.
- `components/sources/sources-audio-mixer.tsx` (use the shared faders),
  `components/studio/quick-settings.tsx` (drop the System audio row),
  `components/tabs/studio-tab.tsx` (lazy import, fallback skeleton, comment).

**Changes:**

1. `AudioSection` wraps both rows in one audiocn `Mixer` with
   `minDb={-60} maxDb={0}` and `scrollable={false}` on `MixerChannels`, as
   Sources does, so both meters share a scale and Cmd/Ctrl+Up/Down moves
   between rows.
2. **Microphone row:** today's header (Muted chip, `ShortcutKeys`,
   `MuteToggle`), the `DevicePicker`, the meter with every probe attribute
   kept, then `MicrophoneGainFader`. Dim the meter while muted, as today.
3. **System audio row** (only while `systemAudio.visible`): `DesktopIcon`,
   title "System audio", the state word through `lib/state-labels.ts`, the
   `Switch` in a `ShortcutTooltip` (`systemAudioToggle`), disabled with its
   reason while permission is missing. While checked: the meter (S1's input)
   or, for `'clips-off'`, the resting meter plus the D6 line in
   `text-muted-foreground`; then `SystemAudioGainFader`. Issue lines and their
   one action as `SystemAudioInspectorValue` has them today. New attributes:
   `data-videorc-studio-system-audio`, `data-videorc-studio-system-audio-level`.
4. Rows are flush, split by a hairline (`GroupedList` or `divide-y`), no
   cards, no tinted panels, no `cursor-pointer`, controls at their default
   heights (no `h-*` at call sites).
5. The section title is "Audio". The picker keeps its hidden "Microphone"
   label (the perf probe and screen readers).
6. Writes are unchanged: each fader tick makes the same `setCaptureConfig`
   update Sources makes; the latest-wins queue coalesces.
7. Fallback skeleton: the picker, two meter lines and two fader lines, so the
   inspector doesn't jump when the chunk loads.

**Tests** (`audio-section.test.ts` renders `AudioSectionView` from props):

- Both rows, faders at their values, readouts `0.0 dB` and `−6.0 dB`
  (typographic minus), resets write 0 and −6.
- System audio row absent when not visible; disabled switch and fader with
  the permission reason; Paused with Resume; the D6 line only for
  `'clips-off'`; no line while Clips restarts.
- Muted microphone: chip, dimmed meter.
- `quick-settings.test.ts`: no System audio row; Screen and Camera stay.
- `use-studio-context-partition.test.ts`, `audiocn-adoption.test.ts` and
  `renderer-style-guards.test.ts` pass untouched.

**Verification:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`, `pnpm build`,
`pnpm check:renderer-assets` (eager bytes unchanged; record the Studio chunk
growth).

**By-eye (owner),** both themes, at the narrowest inspector width: idle with
Clips on (both meters move, faders move them), Clips off (the line), muted,
recording, live, permission missing, echo pause.

**Done when:** gates pass and the owner accepts the by-eye.

## Slice S3: the same section on Retro LCD

**Files:** `components/studio/retro-lcd-studio.tsx` (`RetroAudioSectionView`
replaces `RetroMicrophoneSectionView`; `RetroQuickSettings` drops System
audio), `retro-lcd-studio.test.ts`.

**Changes:**

1. One `LcdPanel` titled "Audio": the Microphone rows as today (header with
   mute, LCD picker, switch status, `MicLcdMeter scale={false}`), then
   `LcdDisplaySeparator`, then System audio: an LCD row with its switch
   (reuse what `RetroSystemAudioValue` draws), its `MicLcdMeter` and the D6
   line in `LCD_MESSAGE` style.
2. Gain per D5: the shared faders inside the screen, skinned from outside by
   `className` with `--lcd-display-lit` / `--lcd-display-ink-dim`. No edit
   to vendored audiocn files. If the by-eye rejects it, build the fallback
   row, not a new widget library.
3. The same data attributes as S2, so the perf probe works in both looks.

**Tests:** the Retro view renders both rows, the faders, the permission and
Clips-off states; `RetroQuickSettings` has no System audio row.

**Verification:** as S2.

**Done when:** gates pass and the owner accepts the Retro by-eye in both
themes.

## Slice S4: docs, cost and acceptance

**Changes:**

1. `.claude/skills/videorc-design/SKILL.md`: "Where things live" (the Studio
   mirrors the Audio section: picker, levels, Gain, mute, the System audio
   switch; the Sources mirror is Screen and Camera); the mapping row "Audio
   controls" (Sources rows and the Studio Audio section).
2. `docs/audiocn.md`: the Studio now uses `fader`.
3. `docs/acceptance/2026-10-xx-studio-audio-balance.md`: S0 output, by-eye
   screenshots (both looks, both themes), the bundle numbers, the CPU run.
4. `plans/README.md` entry, and this plan's execution notes.

**CPU:** two live meters instead of one. Run interleaved main and branch
twice each, as plan 196 did:
`VIDEORC_SMOKE_SKIP_PREBUILD=1 VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance`,
with Clips on and System audio On. Record renderer and GPU averages and p95.

**Done when:** docs merged with the code, the acceptance record exists, and
the CPU table shows no more than the second meter's cost (owner judges).

## Verification summary

| Gate | Slices |
| --- | --- |
| `pnpm test:scripts` | S0 |
| `pnpm smoke:system-audio` (macOS, Screen Recording grant) | S0 |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | S1 to S3 |
| `pnpm --filter @videorc/desktop test` | S1 to S3 |
| `pnpm build`, `pnpm check:renderer-assets` | S2, S3 |
| `pnpm smoke:preview-performance` (CPU, interleaved) | S4 |

`pnpm smoke:recording-studio` is not required: no capture, mixing,
processing or encoding code changes, and the faders write through the
existing path. Any slice that has to touch those becomes recording-studio
work: STOP and report.

## Edge cases

- **Clips refused** (the software-encoder guard on a weak PC) or given up
  after three failed starts: no bus, so `'clips-off'` and the line.
- **Clips riding a recording:** one bus, one reading; nothing changes at the
  handover except a sub-second rest.
- **Echo guard during Clips:** System audio pauses; S1 shows Paused with
  Resume in the Studio and on Sources, instead of a silent meter.
- **Microphone on a fallback input** (the bus is bypassed): the existing
  `bypassed` issue line explains why System audio isn't mixed.
- **Permission missing (macOS):** switch and fader disabled with the reason;
  no meter.
- **Linux, older Windows:** no System audio row; Audio is Microphone only.
- **Muted microphone:** meter dimmed at `−∞`; Gain still editable.
- **Offline backend:** controls follow the existing offline behaviour of the
  pickers; no new state.

## STOP conditions

- S0 fails (no ring readings, or gain doesn't move them).
- Any change needed in `crates/`, in the live audio processing sync effect,
  or in session start/stop.
- A vendored audiocn file needs an edit (send it upstream instead, as plans
  092, 093 and 196 did).
- Eager bytes grow (`check:renderer-assets`).
- A remote-control, Stream Deck or phone projection test changes.

## Out of scope

- Standby System audio capture with Clips off (D3's alternative; its own plan
  if wanted: ScreenCaptureKit / WASAPI standby, the macOS screen-recording
  indicator, idle CPU).
- A Mix meter, Sounds in the Studio, pan, solo, monitoring, auto-balance or
  loudness targets.
- Any change to ranges, defaults, storage or the Sources layout beyond the
  shared faders and the S1 meter fix.

## Risks

- **Inspector height.** About 70 px more in the default look (two fader rows,
  one meter, the moved switch); more in Retro. The inspector scrolls; the
  by-eye judges it at the narrowest width.
- **Meaning drift on Sources.** S1 makes Sources' System audio meter move
  during Clips. That is the truth, but the old idle copy said otherwise; S1
  replaces it.
- **Owner call reversal.** D1 replaces the 2026-10-02 call. S4 updates the
  design skill so the next plan doesn't undo it.

## How to start

```
git fetch origin
git worktree add -b plan/201-studio-audio-balance ../videorc-201 origin/main
cd ../videorc-201 && pnpm install
```

Check drift first:
`git diff --stat 0438849f..origin/main -- apps/desktop/src/renderer/src/components/studio apps/desktop/src/renderer/src/components/sources/sources-audio-mixer.tsx apps/desktop/src/renderer/src/lib/system-audio.ts apps/desktop/src/renderer/src/lib/mic-meter-input.ts apps/desktop/src/renderer/src/hooks/use-studio-mic-sources.ts crates/videorc-backend/src/recording.rs`.
If those files moved, re-check "Verified facts" before S0.

## Execution notes

None yet.
