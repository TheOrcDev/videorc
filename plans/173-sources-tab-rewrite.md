# Plan 173: Sources, rebuilt (Video beside Audio, one shape for every source)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Gates run once at the end
> (owner rule): write and commit all slices first, then run S7.
>
> **Drift check (run first)**:
> `git diff --stat 72b47404..origin/main -- apps/desktop/src/renderer/src/components/tabs/sources-tab.tsx apps/desktop/src/renderer/src/components/sources apps/desktop/src/renderer/src/components/source-select.tsx apps/desktop/src/renderer/src/components/source-select-searchable.tsx apps/desktop/src/renderer/src/components/page.tsx apps/desktop/src/renderer/src/components/panel-section.tsx apps/desktop/src/renderer/src/components/list-row.tsx apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/lib/system-audio.ts apps/desktop/src/renderer/src/lib/mic-visual-gate.ts scripts/perf-idle-probe.mjs`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P2. Owner request, 2026-10-10: "make this whole layout much
  better with better UX … currently everything is just one on another … plan
  out a complete rewrite of this tab".
- **Effort**: M, 8 slices (S0 is decisions only).
- **Risk**: LOW–MEDIUM. Renderer only: no backend, protocol, or capture
  change. Every device switch still goes through `switchSourceDeviceLive`,
  and every audio value still goes through `setCaptureConfig`. The risk is
  breaking a probe or smoke that finds a control by its DOM (see "Who reads
  this page's DOM").
- **Depends on**: none.
- **Category**: UI / product design
- **Planned at**: commit `72b47404` (origin/main), 2026-10-10
- **Route**: UI/Product Design, fit 9. Load the `videorc-design` skill and
  the `shadcn` skill before S2. Model lane `opus-4.8` for S2 to S5 (scoped,
  taste-heavy UI); `gpt-5.5` for S1 and S6 (pure helpers, selector
  compatibility). Escalate to `fable-5` without asking if a by-eye pass
  (S7) comes back below the bar.

## Owner decisions (answer before S1)

Each has a recommendation. The slices below assume the recommendation.

**Answered 2026-10-10:** the owner said "Execute the entire plan and create a
PR", which takes every recommendation below (D1–D6) as written.

| #   | Question | Recommendation |
| --- | -------- | -------------- |
| D1  | Page layout | **Two columns at `lg`: Video (Screen, Camera) beside Audio (Microphone, System audio)**, stacked below `lg`. It is the Config-grid archetype `page.tsx:12` already names for Sources, and it halves every line length. Rejected: a list-plus-inspector (one more click for every change, for four sources), a console of vertical strips (video sources don't fit it; the owner turned down a mixer look on Studio in plan 092), and a width-capped single column (leaves half the pane empty and fixes neither the hierarchy nor the shapes). |
| D2  | Where does Sync go? | **Folded into the Microphone's "More" area**, closed by default. While the offset is not the default, the Microphone header shows a `Sync +150 ms` tag, so a hidden setting is never a surprise. |
| D3  | Calibrate (measured lag, Import JSON, Apply) | **Development builds only.** The JSON comes from `pnpm measure:av-sync`, which needs this repo; a packaged app user has no way to make one. Packaged builds keep the Sync slider, its number field and Reset. |
| D4  | System audio's three-line paragraph | **One line under the title** ("Everything your Mac plays, except Videorc.") **plus three short points in its "More" area** (your stream open in a browser tab is captured too, so mute that tab; wear headphones; your Mac's volume and mute don't change what's recorded). |
| D5  | Live pictures of the screen and camera on this page | **Not in this plan.** The renderer has no source-picture transport today (see "Pictures"); a picture would need backend snapshots and a perf gate. If wanted, it is a follow-up plan that turns the Video column's rows into picture cards. |
| D6  | The Microphone's "Monitoring" label | **Drop it.** Use the one status vocabulary below: nothing extra while the level moves, `Muted` when muted, `Live` during a session; a dead meter keeps its reason line under the meter. |

## Why the page reads as "one on another" (code read at `72b47404`)

Paths are under `apps/desktop/src/renderer/src/` unless stated. The owner's
screenshot was taken at a ~1,166 pt window, so the work pane is ~990 pt wide.

1. **One column across a wide pane.** `SourcesTab` is a `PageStack` of two
   `PanelSection`s (`components/tabs/sources-tab.tsx:141-327`). Every control
   stretches to the pane: the microphone picker is ~800 pt wide, the Sync
   slider ~790 pt, the meters ~530 pt. A label and its value end up far
   apart (Sync at the left edge, "150 ms" at the right; the System audio
   switch ~700 pt from its title). `page.tsx:12` lists Sources as a
   Config-grid page (two columns at `lg`); the page never adopted it.
2. **Inverted hierarchy.** Field labels come from `FieldLabel` (14 px / 500,
   `source-select.tsx:126`), bigger than the section titles they sit under
   (13 px / 600, `panel-section.tsx:43`). "Screen / window" outranks
   "Capture sources".
3. **Four sources, four shapes.** Screen and Camera are a label, a select
   and a chip on its own line. The Microphone is a labelled select, then a
   separate strip titled "Microphone" again
   (`sources-audio-mixer.tsx:197-212` and `:319-332`). System audio is a
   strip with no picker, a switch, a paragraph and a second switch
   (`:606-678`). Off is said four ways: a "None" item, an "Off" item, a
   Mute button and a Switch.
4. **Status floats.** Each `RuntimeChip` sits on its own line under its
   select (`sources-tab.tsx:234-273`), attached to nothing.
5. **Rare controls take the best space.** Sync, an A/V offset most people
   never touch, is a full-width slider with Reset and a number field
   (`sources-audio-mixer.tsx:390-414`). Calibrate shows Import JSON to
   people who cannot produce the file (`:465-566`).
6. **A wall of text.** System audio's paragraph is always shown
   (`:661-666`), and the echo-guard switch below it reads as an unrelated
   setting (`:667-678`).
7. **A dead meter.** The System audio meter is drawn while off and while
   idle, where it can never move (`systemAudioMeterInput` only reads during a
   session). It looks broken.
8. **Alerts push, controls stay live.** Permission alerts stack at the top
   of the capture section (`sources-tab.tsx:166-219`) while the select they
   are about still looks enabled. The design skill's rule is "Locked means
   disabled, with one reason".
9. **Missing facts.** The backend already reports what each video source
   delivers (`DiagnosticStats.previewScreenNativeWidth/Height`,
   `previewCameraSelectedFormatWidth/Height`, `previewCameraSourceFps`,
   `shared/backend.ts:3029-3128`), but the page shows none of it unless the
   camera falls short. A source missing its device shows no chip at all
   (`sourceRuntimeChip` returns null for `source-missing` /
   `device-missing`, `sources-tab.tsx:50-52`).

## Design

### The page

```
 Sources                                                         (toolbar, title only)
 What gets recorded and streamed. Changes apply live.          [⟳ Refresh devices]
 ─────────────────────────────────────┬──────────────────────────────────────────────
 Video                                │ Audio
 What people see.                     │ What people hear, after gain. Nothing is
                                      │ processed automatically.
 ┌──────────────────────────────────┐ │ ┌─────────────────────────────────────────┐
 │ ▣ Screen                ● Live   │ │ │ 🎙 Microphone   Sync +150 ms  ● Live 🔈 ⌄│
 │   [ Display 1                 ▾ ]│ │ │   [ MacBook Pro Microphone           ▾ ]│
 │   2560 × 1664                    │ │ │   ▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯               │
 ├──────────────────────────────────┤ │ │   Gain ───────●───────        0 dB      │
 │ ◉ Camera                ● Live   │ │ ├─────────────────────────────────────────┤
 │   [ MacBook Pro Camera        ▾ ]│ │ │ 🖥 System audio            Off  [◯ ]  ⌄ │
 │   1920 × 1080 · 30 fps           │ │ │   Everything your Mac plays, except      │
 └──────────────────────────────────┘ │ │   Videorc.                               │
                                      │ └─────────────────────────────────────────┘
```

- **Frame.** The toolbar keeps the title only. A `PageHeader` row carries
  the intro line and the page's one action, Refresh devices (it re-reads
  every device, so it belongs to the page, not to a section; design skill:
  page actions sit in the PageHeader row).
- **Grid.** `ConfigGrid` with `CONFIG_GRID_PAIR`: two flush `PanelSection`s,
  **Video** and **Audio**, split by the column hairline that runs the full
  height. Below `lg` they stack, Video first. At the owner's window size each
  column is ~495 pt, so a picker is ~430 pt, not 800.
- **Sets of like things are one `GroupedList`** (design skill, "Lists, not
  card stacks"). Each column holds one GroupedList with one item per source,
  built like the Livestream destination rows (`components/streaming/destination-card.tsx:305-350`):
  a header row, a body, and a folded "More" area.

### One shape for every source: `SourceItem`

```
 header   [icon] Title   tag?           status chip   quick control   ⌄ (only if it has More)
 body            device picker (label kept for screen readers only)
                 facts line, or the warning that replaces it
                 audio only: level meter, then  Gain/Level  fader  value
 More            the source's rare settings, closed by default
```

- **Header** (`ListRow`, `h-auto min-h-10`): a 16 px icon in the 20 px
  tile, the title (`Screen`, `Camera`, `Microphone`, `System audio`), an
  optional outline tag (`Sync +150 ms`), the status chip, then the one quick
  control the source has, then the More chevron.
- **Quick control**: Microphone, the Mute toggle (with its shortcut
  tooltip, unchanged); System audio, the On switch. Screen and Camera have
  none: their picker's None / Off item is how they turn off.
- **Body** is indented to the title (12 px + 20 px tile + gap), so the left
  edge of every picker, facts line and meter lines up down the column.
- **The picker** is the existing `SourceSelect` with `labelHidden` (the row
  title names it). Its visible label disappears; its accessible name stays
  exactly what it is today, so probes that find it by label keep working
  (see S6).
- **More** uses `Collapsible`, like Calibrate today. Its open state is kept
  per source in `localStorage` (try/catch; closed when unreadable).

### One status vocabulary (`lib/source-status.ts`)

Three pure functions (`videoSourceStatus`, `microphoneStatus`,
`systemAudioStatus`) replace `sourceRuntimeChip` (`sources-tab.tsx:23-56`),
the Microphone's monitor label (`lib/mic-visual-gate.ts:43-63`) as a chip,
and System audio's `stateLabel` as a chip. A row with nothing to add shows
**no chip**: the picker already says None or Off, the System audio switch
says Off, and a moving meter says the microphone works. A dead meter
explains itself on the line under the meter, not in a second chip.

| Source | Condition | Chip | Tone |
| ------ | --------- | ---- | ---- |
| Screen, Camera, Microphone | a live switch in flight | `Switching` | warn |
| Screen, Camera, Microphone | none selected | none | |
| Screen, Camera | delivering frames (wins over a lagging device list) | `Live` | good |
| Camera | live, newest frame older than 3 s | `Stale 4s` (hint: re-select to restart) | warn |
| Screen, Camera, Microphone | permission missing | `Needs permission` | warn |
| Screen, Camera, Microphone | saved device not listed, or listed unavailable | `Not found` | warn (today: no chip) |
| Screen, Camera | starting | `Starting` | warn |
| Screen, Camera | failed | `Failed` (hint: the backend message) | error |
| Microphone | muted | `Muted` | neutral |
| Microphone | session running, not muted | `Live` | good |
| Microphone | working, idle | none | |
| System audio | off | none | |
| System audio | turning on / turning off | `Turning on…` / `Turning off…` | neutral |
| System audio | on, no session | `On` | neutral |
| System audio | mixed into a session | `Live` | good |
| System audio | echo guard paused it | `Paused` | warn |
| System audio | lost, bypassed or failed to start | `Stopped` (the issue line says which) | warn |

### Facts line (`lib/source-facts.ts`)

Monochrome, 12 px, tabular numbers, only when the source is live. Read
from the preview statuses the page already has (`useStudioPreview()`:
`PreviewScreenStatus` / `PreviewCameraStatus`, `shared/backend.ts:2356-2425`),
not from diagnostics:

- Screen: `2560 × 1664` from `nativeWidth/nativeHeight` (fall back to
  `width/height`). No fps: a screen only delivers on change, so a rate would
  mislead.
- Camera: `1920 × 1080 · 30 fps` from the selected format, at the requested
  rate capped by the format's max fps. Not the measured `sourceFps`: it
  flickers between neighbours (29, 30, 29). When
  `cameraFormatShortfall` reports a gap, its message replaces the facts line
  in the warning tone (`sources-tab.tsx:278-283` today).
- System audio: the one fixed line from D4.
- Microphone: none (the meter is the fact).

### Per source

- **Screen**: picker (searchable, grouped Screens / Windows, as in Studio
  Inputs since #514), the switch-status line under it, facts. Development
  builds put the synthetic diagnostic source switch in Screen's More area
  (today a boxed row at the bottom of the section, `:292-323`; keep its
  `data-videorc-synthetic-source-toggle`).
- **Camera**: picker (Off first), the switch-status line, facts or the
  shortfall warning. No More area.
- **Microphone**: picker, the meter (unchanged `MicLevelMeter`, segmented,
  full body width), then one row `Gain  [fader]  0 dB`. The level-unavailable
  line stays. More: the Sync `ParameterSlider` (unchanged range, reset and
  semantics) with the description "Delays your voice to line up with the
  video." plus "Applies from the next recording or stream." during a
  session; Calibrate under it in development builds only (D3).
- **System audio**: header switch, the D4 line, then the meter and
  `Level [fader] −6 dB` only while it is on. While on with no session the
  meter's place says "Level shows while recording or live" (tertiary) instead
  of a dead bar. Issues (permission, unavailable, echo with Resume, bypassed)
  sit under the line, unchanged copy and actions. More: "Pause if your stream
  echoes back" as a labelled row with its switch, then the three D4 points.

### Locked states

- A missing Screen Recording or Camera permission shows **one** `Alert` at
  the top of the Video column with its one action (Open Screen Recording /
  Enable Camera, plus Show Capture Helper), and the affected item is
  disabled with `Needs permission`. Microphone permission does the same at
  the top of the Audio column. `deviceList.warnings` stay above the grid,
  full width.
- System audio without permission keeps today's rule: the header switch and
  fader disabled, the reason and Open Settings under the line.

### What does not change

- Device switching, the source-selection controller and its error copy
  (`SourceSwitchStatus`), the audiocn controls (`Fader`, `MuteToggle`,
  `ParameterSlider`, `MicLevelMeter`) and their ranges, detents and resets,
  every stored setting and its default, the shortcuts, and the tab id,
  shortcut (⌘2) and nav entry.
- No new audio controls (design skill: nothing without a backend behind it:
  no pan, solo, monitor or player volume).
- No toasts for source changes (design skill, toast discipline).

### Pictures (why D5 says not now)

FILL FROM RESEARCH: what exists for source pictures and the AGENTS.md
transport rules.

## Who reads this page's DOM

FILL FROM RESEARCH.

## In-flight work on these files

FILL FROM RESEARCH.

## Slices

### S0: Owner decisions

Record the answers to D1–D6 at the top of this plan. If D1 is not the
recommendation, STOP: the slices below assume it.

### S1: The status and facts helpers

Files:

- `lib/source-status.ts` (new), `lib/source-status.test.ts` (new)
- `lib/source-facts.ts` (new), `lib/source-facts.test.ts` (new)

1. `sourceStatus(input) → { label, tone, hint? } | null` implementing the
   vocabulary table exactly. Inputs are plain data (kind, preview state,
   frame age, pending switch, selected id, device status, muted, session,
   meter reason, system audio view), never hooks.
2. `screenFacts(stats)` and `cameraFacts(stats)` returning a string or
   null; `cameraFacts` returns null when `cameraFormatShortfall` reports a
   gap (the caller shows the shortfall instead).
3. Tests: one case per table row; `Not found` for both missing kinds; stale
   only for cameras; facts null when not live or a dimension is missing;
   numbers use `×` and a thin space-free `1920 × 1080` format; fps rounds.

Done when:

- `pnpm --filter @videorc/desktop test source-status source-facts`
- `pnpm typecheck`

### S2: The `SourceItem` primitive

Files:

- `components/sources/source-item.tsx` (new)
- `components/sources/source-item.test.ts` (new)

1. Compose `ListRow` (header), a body slot, and an optional `Collapsible`
   More area, as the anatomy above. Props: `icon`, `title`, `tag?`,
   `status?` (the S1 shape, rendered with `StatusBadge`), `control?`,
   `more?`, `moreLabel` (for the chevron's `aria-label`), `disabled?`,
   `id` (the `localStorage` key and `aria-controls` target), `children`.
2. The chevron is a ghost icon `Button` with `aria-expanded` and
   `aria-controls`; the header row itself does not toggle (unlike a
   destination row) because its quick control and picker are the common
   clicks.
3. No new radii, colours, shadows or `cursor-pointer`; `renderer-style-guards`
   must stay green. Use `@/components/icons` only.
4. Tests (`renderToStaticMarkup`, the house pattern): header order; the tag
   and chip render; More closed by default and absent when `more` is
   undefined; `disabled` marks the item and its controls; the hint becomes
   the chip's tooltip text.

Done when:

- `pnpm --filter @videorc/desktop test source-item renderer-style-guards`
- `pnpm typecheck && pnpm lint`

### S3: The Video column

Files:

- `components/sources/video-sources.tsx` (new)
- `components/sources/video-sources.test.ts` (new)
- `components/tabs/sources-tab.tsx` (move the Screen/Camera code out)

1. Move the Screen and Camera pickers, their `applyCaptureSource` /
   `applyCameraSource` wiring, the camera shortfall and the DEV synthetic
   switch into a `VideoSources` section built from `SourceItem`s.
2. Status from `sourceStatus`, facts from S1, the switch-status line in
   the body (unchanged component).
3. The Screen Recording and Camera permission alerts move to the top of
   this column; the affected item is disabled with `Needs permission`.
4. The session-active line ("Video sources switch live after …",
   `sources-tab.tsx:286-290`) becomes the column description's second
   sentence while a session runs, instead of a free paragraph.
5. Export a props-only view (`VideoSourcesView`) so tests render it without
   the studio context, like `MicrophoneChannel` today.
6. Tests: both items render with facts; a missing camera says `Not found`;
   a shortfall replaces the facts line; permission disables the item and
   shows one alert; the DEV switch keeps its data attribute.

Done when:

- `pnpm --filter @videorc/desktop test video-sources`
- `pnpm typecheck`

### S4: The Audio column

Files:

- `components/sources/sources-audio-mixer.tsx` → becomes
  `components/sources/audio-sources.tsx` (rename with `git mv` so history
  follows)
- `components/sources/sources-audio-mixer.test.ts` → `audio-sources.test.ts`

1. Microphone and System audio become `SourceItem`s inside the audiocn
   `Mixer` (keep it: it gives the meters their range). The section is titled
   **Audio**; its description is unchanged.
2. Microphone: picker in the body (no second "Microphone" title), meter,
   one `Gain` row; Mute in the header; Sync and (DEV only) Calibrate in More;
   the `Sync +N ms` tag when `microphoneSyncOffsetUserSet` and the offset is
   not 0.
3. System audio: switch in the header, the D4 line, meter and `Level` row
   only while on, the idle caption instead of a dead meter, issues unchanged;
   echo guard and the three points in More.
4. Keep every existing `data-videorc-*` attribute on the element it marks
   today (`data-videorc-mic-channel`, `data-videorc-mic-preview`,
   `data-videorc-mic-monitor-state`, `data-videorc-mic-level-reason`,
   `data-videorc-system-audio-settings`, `data-videorc-system-audio-visualizer`,
   `data-videorc-sync-calibration`) and every `aria-label`.
5. Port the tests. Assertions about layout change; assertions about
   behaviour (shortcut tooltip keeps the switch's own `data-state`, typed
   Sync clamps and stores whole ms, reset clears the user-set flag, Windows
   copy has no Mac or Screen Recording words, echo guard on by default,
   Resume on echo) must survive unchanged. Add: no meter while System audio
   is off; the idle caption while on outside a session; Calibrate absent
   when `developer` is false; the Sync tag appears only off-default.

Done when:

- `pnpm --filter @videorc/desktop test audio-sources studio-mic-meter microphone-section`
- `pnpm typecheck`

### S5: The page frame

Files:

- `components/tabs/sources-tab.tsx`
- `components/page.tsx` (comment only, if the archetype note needs a word)

1. `SourcesTab` becomes: `PageHeader` (intro line + Refresh devices, the
   refresh logic unchanged: `refreshBackend({ fresh: true })`, the spinning
   `SyncIcon`), `deviceList.warnings` as full-width alerts, then
   `ConfigGrid className={CONFIG_GRID_PAIR}` holding `VideoSources` and
   `AudioSources`.
2. Delete the dead code (`RuntimeChip`, `sourceRuntimeChip`, the old grid).
3. Check the shell: Sources stays inside `PaneBody`'s scroll (no tab strip,
   so no own scroll region). The stacked layout below `lg` must not clip.

Done when:

- `pnpm --filter @videorc/desktop test`
- `pnpm typecheck && pnpm lint && pnpm format:check`

### S6: Probes and smokes still find everything

FILL FROM RESEARCH: the exact list of scripts and the selector each one uses.

1. Run each script's selector against the new markup (grep, then the
   by-eye pass in S7). Fix the markup, never the probe, unless the probe
   reads layout text that this plan removes on purpose; then update the
   probe in the same commit and say so in the PR.

Done when: FILL.

### S7: Gates, by-eye proof and PR

1. Gates: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
   `pnpm --filter @videorc/desktop test`, `pnpm build`,
   `pnpm check:renderer-assets` (record before and after; the Sources chunk
   is lazy, the eager budget must not move).
2. Recording-studio rule (AGENTS.md: the page is the capture-selection
   UI): `pnpm smoke:recording-studio` once, from a checkout whose binaries
   have the TCC grants. If the worktree's binaries lack them, say so and run
   it from `~/projects/videorc` on this branch.
3. By eye, both themes, with `pnpm ui:driver` + `pnpm ui:cmd open-tab
   sources` + `capture-page`, at window widths 900, 1166 (the owner's) and
   1600 pt: two columns at `lg` and up, one below; nothing clipped; the
   column hairline runs the full height; pickers, facts and meters share
   one left edge; System audio off shows no meter.
4. Open the PR (one PR for the plan). Body: before/after screenshots, the
   D1–D6 answers, and the probe list from S6 with each result.

Done when: all gates green or each red one explained with its output, and
the PR is open.

## Out of scope

- Source pictures (D5). Follow-up plan if the owner wants them.
- Studio's Inputs rows and Microphone section, the session sliver, ⌘K
  entries and remote-control intents (they keep deep-linking here; their
  look is not part of this plan).
- Any backend, protocol or capture behaviour.
- New audio controls (pan, solo, monitor, player volume) and new
  shortcuts.

## STOP conditions

- A behaviour (not a line number) changed in the drift-check files.
- A probe or smoke needs a backend change to keep finding its control.
- Keeping an `aria-label` or `data-videorc-*` attribute is impossible with
  the new anatomy.
- `pnpm check:renderer-assets` shows the eager budget moving.
- The owner answers D1 with anything but the recommendation.

## Verification summary

| Slice | Proof |
| ----- | ----- |
| S1 | helper unit tests |
| S2 | `SourceItem` markup tests, style guards |
| S3 | Video column view tests |
| S4 | ported mixer tests plus the new ones |
| S5 | full desktop unit suite, typecheck, lint, format |
| S6 | each probe's selector found in the new markup |
| S7 | build, asset budget, recording-studio smoke, by-eye at three widths × two themes |

## As built

(fill in after execution)
