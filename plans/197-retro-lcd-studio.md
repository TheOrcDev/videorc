# Plan 197: Retro LCD, the Studio on LCD screens

**Status:** BUILT 2026-10-25 on `feat/studio-lcd-style`. Owed: the owner's
look in both themes, and on the next Windows build.
**Priority:** P2. Owner requests, 2026-10-25, in order:

1. "Let's make the entire studio in this style
   (https://www.audiocn.dev/docs/components/lcd-display). All the dropdowns
   should be like this for the microphone, for the screen, for everything."
2. On the first build: "these things are now not looking good together"
   (circled: Record and Go Live with the line under them, the sans-serif
   section titles, the mute button, the Open Sources link).
3. "I'm not very happy about this one, let's put it only as some 'retro LCD'
   option in settings, so we can make it optional."
4. "Put also that new meter that we already implemented to be in retro lcd
   theme."

## What it is

**Retro LCD**, a switch in Settings → General → Appearance, off by default.

- **Off:** the Studio is main's: inspector rows, buttons, section titles.
  Every level meter (Studio Microphone, Sources Microphone, System audio,
  Sounds) is the segmented bar again, as before plan 196.
- **On:** every Studio inspector section is one audiocn LCD screen. Its
  title sits on the screen, with its one action ("Open Sources") as LCD
  text. Rows are dim labels and lit values.
  - **Dropdowns:** Microphone, Screen and Camera open their list as a small
    LCD screen inside the app's opaque popup.
  - **Transport:** the session's state and clock, Record (in the record red)
    and Go Live as keys, and why a start is off, all on one screen.
  - **Microphone:** title, mute, dropdown and level on one screen.
  - **Takeovers:** rows that read On or Off.
  - **Meters:** every level meter is the LCD meter from plans 196, #812 and
    #813, on the app's glass.

The preview, Scenes, the soundboard pads and the vertical leg monitor keep
their look in both: they are pictures and pads, not readouts.

## Decisions

- **One device picker.** `DevicePicker` gained `trigger="lcd"` (its row, the
  lit value with a pixel chevron, the list as a small screen) instead of
  using audiocn's Base UI select. The picker keeps search, groups, statuses,
  "Finding cameras…", the smokes' hooks, and the docked preview's popper
  rule. Base UI's popup marks open with `data-open`, which
  `DOCK_BLOCKING_POPPER_SELECTOR` does not see.
- **Two looks, one state.** The retro sections live in
  `components/studio/retro-lcd-studio.tsx` and share their state with the
  default ones. They use `useStudioSources`, `useTakeovers`,
  `useSessionOutputSummary`, `SessionNotices`, and the live session rows,
  which take a `look`. The default files are main's markup, so the default
  Studio cannot drift.
- **The screen kit** (`components/lcd-panel.tsx`):
  - `LcdPanel`: `LcdDisplay` at the small size on `LCD_ON_GLASS`. Since
    #813 the bezel is a glass chip, and in dark the screen is the solid at
    35%. Tracking is 0.08em, so device names fit 20rem.
  - Rows: `LcdPanelHeader`, `LcdPanelRow`, `LcdPanelNavRow`,
    `LcdPanelPressRow`, `LcdPanelSwitch`, `LcdPanelKey`, `LcdPanelAction`.
  - `LCD_MESSAGE` for sentences, in sentence case.
  - `StudioLookContext`, which carries the look to the Sources meters.
- **Floats stay opaque.** A dropdown's list is a screen with the display's
  own opaque glass inside `glass-float`, never the see-through inspector
  glass.
- **Words stay the same in the DOM.** The screen prints capitals with CSS,
  so `data-videorc-session-status` and the other hooks the smokes read keep
  their exact text.

## As built

- `lcd-panel.tsx` (new), `studio/retro-lcd-studio.tsx` (new).
- `device-picker.tsx`: `trigger="lcd"`, `rowLabel`.
- `mic-level-meter.tsx`: `look` (or the page's `StudioLookContext`). The
  default is the segmented `LevelMeter`, as before #800. `MicLcdMeter` is
  the meter alone, for a screen holding other rows.
- `session-panel.tsx`: shared hooks and rows, `look` on the live rows.
  `quick-settings.tsx`: `useStudioSources`. `microphone-section.tsx` picks
  its view by the setting. `session-mic-sliver.tsx`: `ink`.
- `studio-tab.tsx`: picks each section by `settings.retroLcdStudio`. The
  Microphone placeholder is the bar again (the Retro LCD one is a screen).
- `sources-audio-mixer.tsx`: provides `StudioLookContext` from the setting.
  `source-switch-status.tsx`: `look="lcd"` for its one action.
- `general-settings.tsx`: the Retro LCD switch. `capture.ts`:
  `SettingsState.retroLcdStudio`, renderer-only (localStorage), so there is
  no backend contract.
- Guards: the pressed-row guard allows the takeover rows of both looks, and
  each exception must stay real. `audiocn-adoption.test.ts` allows
  `LcdDisplay` in the kit.

## Verification

See the PR. Unit tests cover both looks: main's Studio tests pass
unchanged on the default, and new tests cover the retro screens, the
transport, the kit, the LCD picker and the Settings switch. The app was
captured with Retro LCD off and on, in both themes, with a dropdown open
(`screencapture -l`, composited glass).
