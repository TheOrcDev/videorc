# Plan 208 acceptance: Liquid Chrome colours

S0 to S6 are built and S7's docs are written on
`plan-208-liquid-chrome-colour` (PR pending). The final gate run and the
owner's by-eye are below.

Baseline: `origin/main` `dc1309cb` (before any Liquid Chrome product change).

## Before (origin/main dc1309cb)

Captures live under `/tmp/videorc-plan208/before/`. Main-window shots used
`node scripts/ui-theme-screens.mjs` with tab ids `studio`, `sources`,
`layout` (plan name “scene”), `assets`, `streaming` (plan name
“livestream”), `library`, `settings`, and `ai` (plan name “buddy”). Light
main-window tabs used `node scripts/capture-ui-pages.mjs --theme=light`
plus `ui-cmd` for Assets.

### Main window (CDP compositor screenshots)

| Surface                  | Dark                                                        | Light                                                        |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Studio                   | `/tmp/videorc-plan208/before/videorc-ui-studio-dark.png`    | `/tmp/videorc-plan208/before/videorc-ui-studio-light.png`    |
| Sources                  | `/tmp/videorc-plan208/before/videorc-ui-sources-dark.png`   | `/tmp/videorc-plan208/before/videorc-ui-sources-light.png`   |
| Scene (`layout`)         | `/tmp/videorc-plan208/before/videorc-ui-layout-dark.png`    | `/tmp/videorc-plan208/before/videorc-ui-layout-light.png`    |
| Assets                   | `/tmp/videorc-plan208/before/videorc-ui-assets-dark.png`    | `/tmp/videorc-plan208/before/videorc-ui-assets-light.png`    |
| Livestream (`streaming`) | `/tmp/videorc-plan208/before/videorc-ui-streaming-dark.png` | `/tmp/videorc-plan208/before/videorc-ui-streaming-light.png` |
| Library                  | `/tmp/videorc-plan208/before/videorc-ui-library-dark.png`   | `/tmp/videorc-plan208/before/videorc-ui-library-light.png`   |
| Settings (General tab)   | `/tmp/videorc-plan208/before/videorc-ui-settings-dark.png`  | `/tmp/videorc-plan208/before/videorc-ui-settings-light.png`  |
| Buddy (`ai`)             | `/tmp/videorc-plan208/before/videorc-ui-ai-dark.png`        | `/tmp/videorc-plan208/before/videorc-ui-ai-light.png`        |

Extra light-only settings sub-tabs and Buddy sub-tabs from
`capture-ui-pages.mjs` (same directory, names like
`videorc-ui-settings-general-light.png`, `videorc-ui-buddy-live-light.png`).

### Studio Comments rail (main window)

| Theme | Path                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| Dark  | not captured — `ui-theme-screens.mjs` exited after tab sweeps: `Three-platform Comments rail did not render` |
| Light | not captured — same script abort before the light pass                                                       |

### Stream Manager (detached Chat window)

Representative 1280×720 / activity layouts from `pnpm probe:comments-window`
(probe exited 1 on clipboard copy; PNGs still written).

| Theme | Path                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| Dark  | `/tmp/videorc-plan208/before/videorc-stream-manager-dark.png` (copy of probe `videorc-comments-sweep-1280-live.png`)      |
| Light | `/tmp/videorc-plan208/before/videorc-stream-manager-light.png` (copy of probe `videorc-comments-activity-rows-light.png`) |

Full probe set (not copied): `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-comments-window-probe-1793115777741/`.

### Captions reader (detached window)

| Theme | Path                                                                                  |
| ----- | ------------------------------------------------------------------------------------- |
| Dark  | not captured — no maintained smoke/probe writes Captions-window PNGs on this baseline |
| Light | not captured — same                                                                   |

### Notes window

| Theme | Path                                                                              |
| ----- | --------------------------------------------------------------------------------- |
| Dark  | not captured — no `notes-window-capture-page` (or equivalent) in existing tooling |
| Light | not captured — same                                                               |

### Welcome / first-run screen

| Theme | Path                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dark  | not captured — `ui-theme-screens.mjs` dismisses onboarding before tab sweeps; `smoke:first-run` is not in `package.json` on this baseline |
| Light | not captured — same                                                                                                                       |

## S0 gate notes

- `pnpm build` and `cargo build -p videorc-backend` (debug) succeeded in the
  plan-208 worktree.
- `ui-theme-screens` failure log: `/tmp/videorc-plan208/ui-theme-screens.log`.
- `probe:comments-window` failure: `links: Copy link puts the link on the
clipboard` — log `/tmp/videorc-plan208/comments-window-probe.log`.

## After (plan-208-liquid-chrome-colour)

Captures stay out of the tree, under `/tmp/videorc-plan208/`; the paths
below are relative to it. Main-window and Stream Manager shots are CDP
compositor screenshots of the dev app on the chrome ground with S4's
controls. Each `pair-*.png` puts dark and light side by side.

### Main window and Stream Manager

| Surface                     | Theme | Before                                       | After                                                |
| --------------------------- | ----- | -------------------------------------------- | ---------------------------------------------------- |
| Studio, idle                | Dark  | `before/videorc-ui-studio-dark.png`          | `s4/final/videorc-ui-studio-idle-dark.png`           |
| Studio, idle                | Light | `before/videorc-ui-studio-light.png`         | `s4/final/videorc-ui-studio-idle-light.png`          |
| Studio, recording (LED lit) | Dark  | not captured                                 | `s4/final/videorc-ui-studio-recording-dark.png`      |
| Studio, recording (LED lit) | Light | not captured                                 | `s4/final/videorc-ui-studio-recording-light.png`     |
| Studio, saved scene         | Dark  | not captured                                 | `s4/final/videorc-ui-studio-saved-scene-dark.png`    |
| Studio, saved scene         | Light | not captured                                 | `s4/final/videorc-ui-studio-saved-scene-light.png`   |
| Sources                     | Dark  | `before/videorc-ui-sources-dark.png`         | `s4/final/videorc-ui-sources-dark.png`               |
| Sources                     | Light | `before/videorc-ui-sources-light.png`        | `s4/final/videorc-ui-sources-light.png`              |
| Scene                       | Dark  | `before/videorc-ui-layout-dark.png`          | `s4/final/videorc-ui-scene-dark.png`                 |
| Scene                       | Light | `before/videorc-ui-layout-light.png`         | `s4/final/videorc-ui-scene-light.png`                |
| Assets                      | Dark  | `before/videorc-ui-assets-dark.png`          | `s4/final/videorc-ui-assets-dark.png`                |
| Assets                      | Light | `before/videorc-ui-assets-light.png`         | `s4/final/videorc-ui-assets-light.png`               |
| Livestream                  | Dark  | `before/videorc-ui-streaming-dark.png`       | `s4/final/videorc-ui-livestream-dark.png`            |
| Livestream                  | Light | `before/videorc-ui-streaming-light.png`      | `s4/final/videorc-ui-livestream-light.png`           |
| Settings → General          | Dark  | `before/videorc-ui-settings-dark.png`        | `s4/final/videorc-ui-settings-general-dark.png`      |
| Settings → General          | Light | `before/videorc-ui-settings-light.png`       | `s4/final/videorc-ui-settings-general-light.png`     |
| Captions page               | Dark  | not captured                                 | `s4/final-captions/videorc-ui-captions-dark.png`     |
| Captions page               | Light | not captured                                 | `s4/final-captions/videorc-ui-captions-light.png`    |
| Output                      | Dark  | not captured                                 | `s4/final-captions/videorc-ui-output-dark.png`       |
| Output                      | Light | not captured                                 | `s4/final-captions/videorc-ui-output-light.png`      |
| Library                     | Both  | `before/videorc-ui-library-{dark,light}.png` | not re-captured                                      |
| Buddy                       | Both  | `before/videorc-ui-ai-{dark,light}.png`      | not re-captured                                      |
| Stream Manager              | Dark  | `before/videorc-stream-manager-dark.png`     | `s4/final/videorc-comments-stream-manager-dark.png`  |
| Stream Manager              | Light | `before/videorc-stream-manager-light.png`    | `s4/final/videorc-comments-stream-manager-light.png` |

Side by side, dark and light: `s4/final/pair-scene.png`,
`s4/final/pair-livestream.png`, `s4/final-captions/pair-captions.png` and
`s4/final-captions/pair-output.png`.

### Dialogs and controls (after only; S0 had no capture for them)

| Surface                                            | Dark                                          | Light                                          |
| -------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| ConfirmDialog with Delete (quiet destructive tint) | `s4/final/videorc-ui-confirm-delete-dark.png` | `s4/final/videorc-ui-confirm-delete-light.png` |
| Save scene dialog                                  | `s4/final/videorc-ui-dialog-save-dark.png`    | `s4/final/videorc-ui-dialog-save-light.png`    |
| ⌘K palette                                         | `s4/final/videorc-ui-palette-dark.png`        | `s4/final/videorc-ui-palette-light.png`        |
| Secondary buttons (chip recipe)                    | `s4/final/videorc-ui-secondary-dark.png`      | `s4/final/videorc-ui-secondary-light.png`      |

- Record and Stop, unlit and lit, both themes: `s4/v2/led-compare.png`.
- Secondary buttons, both themes in one strip: `s4/final/secondary-both.png`.

Not captured on either side: the Captions reader and Notes windows (no
maintained capture writes them) and the Studio Comments rail. They are on
the owner's by-eye list.

### Welcome screen (S5)

Before plan 208, light showed the dark look undimmed; dark is unchanged.
S0 had no capture of either.

| State                                      | Path                               |
| ------------------------------------------ | ---------------------------------- |
| Dark, moving (fresh install)               | `s5/final/fresh.png`               |
| Dark, Increase Contrast (Dim 0.5)          | `s5/final/dark-more-contrast.png`  |
| Dark, reduced motion (the still)           | `s5/final/reduced-motion.png`      |
| Light, moving (inverted)                   | `s5/final/light-moving.png`        |
| Light, reduced motion (the inverted still) | `s5/final/light-still.png`         |
| Light, Increase Contrast (brightness 0.85) | `s5/final/light-more-contrast.png` |
| Light, cold open                           | `s5/final/light-fresh.png`         |

### Phone remote and OAuth page (S6)

No before capture. `s6/old-app.css` keeps the old remote stylesheet for
comparison.

| Surface                                     | Dark                                                           | Light                                                           |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Remote deck, idle (Record)                  | `s6/shots/remote-deck-idle-record-dark.png`                    | `s6/shots/remote-deck-idle-record-light.png`                    |
| Remote deck, idle (Go Live)                 | `s6/shots/remote-deck-idle-stream-dark.png`                    | `s6/shots/remote-deck-idle-stream-light.png`                    |
| Remote deck, recording (LED lit)            | `s6/shots/remote-deck-recording-dark.png`                      | `s6/shots/remote-deck-recording-light.png`                      |
| Remote deck, live                           | `s6/shots/remote-deck-live-dark.png`                           | `s6/shots/remote-deck-live-light.png`                           |
| Remote deck, live, Increase Contrast        | `s6/shots/remote-deck-live-more-contrast-dark.png`             | `s6/shots/remote-deck-live-more-contrast-light.png`             |
| Remote deck, recording, Reduce Transparency | `s6/shots/remote-deck-recording-reduced-transparency-dark.png` | `s6/shots/remote-deck-recording-reduced-transparency-light.png` |
| Remote chat                                 | `s6/shots/remote-chat-dark.png`                                | `s6/shots/remote-chat-light.png`                                |
| Remote, unpaired                            | `s6/shots/remote-unpaired-dark.png`                            | `s6/shots/remote-unpaired-light.png`                            |
| Remote, unreachable                         | `s6/shots/remote-unreachable-dark.png`                         | `s6/shots/remote-unreachable-light.png`                         |
| OAuth page, success                         | `s6/shots/oauth-good-dark.png`                                 | `s6/shots/oauth-good-light.png`                                 |
| OAuth page, failure                         | `s6/shots/oauth-bad-dark.png`                                  | `s6/shots/oauth-bad-light.png`                                  |

## Welcome screen cost (S5)

30 s per theme in the dev app with the Welcome screen moving: Liquid Chrome
Polished at Normal, the 30 fps cap, a 1920 × 1269 canvas.

| Theme          | Frames | fps  | Frame interval p50 / p95 / p99 / max      | GPU process CPU | Renderer CPU |
| -------------- | ------ | ---- | ----------------------------------------- | --------------- | ------------ |
| Dark           | 900    | 30.0 | 33.3 / 34.2 / 34.4 / 39.2 ms              | 5.2%            | 5.7%         |
| Light (invert) | 897    | 29.9 | 33.3 / 34.2 / 34.4 / 130.8 ms (one hitch) | 7.0%            | 5.1%         |

- The budget guard never dropped to the poster in either run.
- Indicative only: the owner was using the Mac during the runs. A repeat on
  a quiet machine and one on the Windows tester's machine are owed. If the
  invert costs a measurable frame-interval regression on Windows, keep the
  poster there and ask (plan STOP condition).

## Gates

On the branch at `26bad307` (macOS, this Mac), `smoke:local-gates` step by
step, each step run even if an earlier one failed:

- **Green (28 of 34):** `check:text-files`, `typecheck`, `build`,
  `check:renderer-assets`, `cargo test -p videorc-backend` (1,233 s),
  `cargo clippy -D warnings`, `smoke:oauth`, `smoke:oauth-guards`,
  `smoke:sources`, `smoke:session-ops`, `smoke:start-labels`,
  `smoke:streaming-secrets`, `smoke:platform-lifecycle`,
  `smoke:multistream`, `smoke:dev`, `smoke:record-latency:gate`,
  `smoke:recording-matrix`, `smoke:remote-control`, `smoke:remote-lan`,
  `smoke:provider-readiness`, `smoke:live-chat-fake-providers`,
  `smoke:youtube-quota`, `smoke:buddy-commands`, `smoke:command-lanes`,
  `smoke:backend-resilience`, `smoke:process-memory:sentinel`,
  `smoke:session-decay:gate`, `smoke:capture-decay-soak:contract`.
- **Red, not this plan:**
  - `smoke:system-audio`: the dev app has no Screen Recording grant here.
  - `smoke:repair-encoder`: the bundled ffmpeg is not built in this
    worktree.
  - `smoke:screens` ("screen switching appears to have restarted the
    session") and `smoke:live-control-recycle` (the backend exited during
    safe finalization): neither touches colour.
  - `probe:comments-window`: the plan 208 check (Chat sits on the chrome
    ground and follows the app theme) passed; only Copy link failed, with an
    empty clipboard, as it has before on this Mac.
- **Invalid, rerun owed:** `probe:ui-glass --gate --surfaces` threw its
  capture out because another app's window (Wispr Flow) covered the main
  window. It proved the ground during S3.

The owner stopped the run in the 60-minute `smoke:capture-decay-soak:gate`
and asked for the whole bundle on main after the merge instead, since
several PRs merged before their CI finished. That run, including
`cargo fmt`, `lint`, `format:check`, `test:scripts`, the desktop tests,
`smoke:first-run`, both preview probes and `smoke:recording-studio`, is
recorded in the PR.

## Owner by-eye owed

In both themes:

- **Every window on the ground** (main, Stream Manager, Captions reader,
  Notes): the cover strength. Is the chrome visible enough, or too much? A
  cover may drop toward its floor (about 0.78 dark, 0.83 light), never past
  it (D10).
- **Go Live…** (D8 flag): enabled it is the chrome primary, and disabled it
  is now a flat 50% chrome slab, both louder than the old outline button.
- **The Record LED**, unlit at idle and lit while recording or live.
- **Secondary buttons** are glass chips everywhere now, including the
  on-stream chat row.
- **An active takeover** renders as the chrome primary
  (`variant={isActive ? 'default' : 'outline'}` in `session-panel.tsx`),
  outside D8's call sites. Keep it, or move it to the outline or the plate.
- **Light Welcome**: the card's separation from the white chrome, and the
  new dialog drop, which every light dialog now has.
- **The phone remote** in both schemes on a real phone.
- **The OAuth page** now follows the browser's scheme; it was dark-always.
- **Windows and Linux**: the ground replaces Mica on Windows 11 and the
  solid palette elsewhere. One pass on the Windows tester's machine.
- **`VIDEORC_GLASS=clear`** against the ground: plan 091's clear glass on
  macOS and Mica on Windows, as the A/B.

## Follow-ups

- Leftover `bg-knob ring-knob-ring` skins in
  `components/audio/gain-faders.tsx`, `components/sounds-section.tsx`,
  `components/scene/banner-inspector.tsx` and
  `components/sources/sources-audio-mixer.tsx`. They are hidden under the
  bead and harmless; remove them.
- `remote_web/icon.svg` keeps `#0d0d0f`: it is brand art, not the palette.
- Phone remote, light mode: the drop shadows on the jump pill and the
  snackbar.
- An `aria-invalid` Switch lost its red border; the ring halo remains.
- Remove `VIDEORC_GLASS=clear` (vibrancy, Mica and the native clear-glass
  strip) once a release has shipped with the ground (D9).
