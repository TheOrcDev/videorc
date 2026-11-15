# Plan 238: A calm Preview start

The owner's ask (2026-11-15, with a screenshot of the Studio while it says
"Connecting…"): "when videorc is turned on and is loading there is always
this blue screen thing, I want that gone. we can put some loading progress
bar or something much nicer and with better UX not random blue thing. plan
it out"

## Status and scope

- **Status: BUILT 2026-11-15** from `origin/main` `206996c10`. The owner
  answered (2026-11-15) "all decisions take recommended, execute the entire
  plan and create a pr": D1 a, D2 a, D3 a, D4 a.
- One PR, as the owner asked, holding the plan and S1–S3. S1 is main-process
  code and carries the native-preview gates; S2 and S3 are UI.
- **Changes from the draft, made while building:**
  - The title is "Starting the preview", not "Starting your studio": the
    card also shows when the Preview opens mid-session, where "studio" is
    not true. Step 1 reads "Waiting for the capture engine", so the two
    lines don't both start with "Starting".
  - The Scene canvas gets no card. Under its surface sits the layout
    diagram the streamer edits, and once S1 makes the surface transparent
    before its first frame, the diagram shows through.
  - A source that cannot send a picture (device missing, access needed,
    failed) is stuck at once, with no 20 s wait.
  - Windows keeps a plain dark ground before the first frame, with no card
    (S1's documented fallback). Nobody could prove on a Windows host that
    `setOpacity(0)` keeps the throttled proof window polling, and that
    window is Windows' production preview.
  - The floating window has no device names (main does not know them), so
    its step 2 reads "Connecting your screen and camera". It reads the
    sources from the compositor status.

## What the blue thing is

It is not a frame of the scene. It is the **diagnostic backdrop of the
Electron proof surface**, painted by the surface's own page.

- In `apps/desktop/src/main/index.ts`, `nativePreviewSurfaceHtml()` (about
  line 6504) gives `body` a white radial dot at `--dot-x`, a 135° gradient
  from blue `rgba(29, 78, 216, .62)` to green `rgba(5, 150, 105, .58)`, and
  52 px white stripes. That matches the screenshot exactly.
- `tick()` (about line 7473) animates it on every animation frame until a
  compositor status arrives. `presentLatestCompositorStatus` (about line
  7406\) animates it again on each compositor frame.
- It goes away only when `body` gets `surface-live` (a source image decodes,
  or the compositor says it is live), or when the native CAMetalLayer
  confirms a present and takes placement (`nativeSurfaceOwnsPlacement`),
  which hides the proof view.
- At launch the backend is still starting (the inspector says "Starting
  Videorc's capture engine…"), so the backdrop shows for the whole startup.
- It sits on top of the stage's own waiting card (`DockedPreviewFrame` in
  `components/preview-stage.tsx`), so that card is never seen.
- The same backdrop shows in all three places the Preview lives: the Studio
  slot, the Scene canvas (the `'scene'` dock slot in `tabs/layout-tab.tsx`)
  and the floating Preview window. It also shows on Windows and Linux, where
  the proof surface is the production preview.
- Nothing reads its pixels. The Preview oracles read `#scene-root` layers
  (`preview-surface-sample.ts`) or the compositor's frame
  (`preview_debug_sample.rs`). `blankFrames` counts decoded source images
  that came out blank. The "proof synthetic surface" readout is a text label
  that only smokes see.

It is **not** the backend test pattern (`synthetic_test_pattern_bgra` in
`compositor.rs`: a grey 64×64 tile with moving lines). Packaged builds
already refuse to show that one (plan 212 S6).

## The rule

Until the first real frame, no preview surface paints anything of its own.
What the user sees is what lies under it: the Studio's startup card, the
Scene canvas's layout diagram, or the floating window's hint. That holds in
both themes. Windows is the exception, with a plain dark ground (see Status).

## What it looks like after

The stage, docked in the Studio:

```
 ┌──────────────────────────────────────────────────────┐
 │                                                      │
 │                                                      │
 │                 Starting the preview                 │  text-sm, medium
 │          Connecting LG HDR 4K and ZV-E10M2           │  text-xs, muted
 │                ━━━━━   ━━━━━   ─────                 │  steps: done, now, next
 │                                                      │
 │                                                      │
 └──────────────────────────────────────────────────────┘
                                      [ Pop out ]  [ Close ]
```

- The background is `bg-video-ground`, which is dark in both themes because
  it frames video. There is no icon and no illustration: the design skill
  keeps hint states short and centred. The camera icon on today's card goes.
- When the first frame arrives, the video covers the card at once. Nothing
  animates out.

The three steps come from real state, never from a timer:

| Step           | Shown while                                                                                         | Second line                                     |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. Engine      | `wsStatus !== 'connected'`                                                                          | Waiting for the capture engine                  |
| 2. Sources     | connected, but a source in the scene is not live yet (`previewScreenStatus`, `previewCameraStatus`) | Connecting _screen name_ and _camera name_ (D2) |
| 3. First frame | the sources are live, but no frame has been presented yet                                           | Drawing the first frame                         |

The indicator (D1 a): three short segments, each a shadcn `Progress`, 2 px
tall and 40 px wide with 6 px gaps. A finished step is full foreground. The
current step breathes slowly, its opacity moving between 30% and 70% over
1.2 s. A step still to come is only the track (the dark theme's muted
white). The card scopes the dark tokens to itself (`className="dark"`), so
the bar and the text read on the dark stage in light mode too. With
`prefers-reduced-motion`
the current step holds still at 60%. There are no percentages: the bar
says which step is running without inventing progress.

**When a step stalls** (D3 a: 20 s on one step), the second line says what
is stuck and offers the one fix that applies:

- Step 2: "ZV-E10M2 hasn't sent a picture yet." (or "LG HDR 4K and
  ZV-E10M2 haven't…") with **Open Sources**. Permission problems never
  reach this line, because the supervisor's warning wins first.
- Step 1: "The capture engine is taking longer than usual." Diagnostics
  already owns backend crashes, so there is no button.
- Step 3: "The first frame is taking longer than usual." The first-frame
  watchdog owns healing, so there is no button.

The existing warning states (`permission-required`, `failed`, a fallback)
always win over the startup card. They already carry their buttons.

**The floating Preview window** today says "Waiting for preview" and "The
native surface appears here as soon as the compositor presents."
(`PREVIEW_WINDOW_HTML`, `PREVIEW_WAIT_DETAIL_DEFAULT`). Those are
engineering words. The window gets the same title, second line and
three-segment bar, drawn in CSS from the `window-palette.ts` tokens. Main
works out the step from the backend connection and the compositor status
it already fetches for the first-frame watchdog.

## Decisions

Recommended answers come first.

- **D1, the indicator.** (a) Three-step segmented bar plus one line.
  (b) One thin bar that fills by step (33%, 66%, 100%). It reads as stuck
  while the engine starts. (c) A spinner and a line, with no bar.
- **D2, name the sources in step 2.** (a) Yes, with the names the scene
  already shows ("LG HDR 4K", "ZV-E10M2"). (b) No: "Connecting your screen
  and camera".
- **D3, when a step counts as stalled.** (a) After 20 s on one step, say
  what is stuck. (b) After 10 s. (c) Never: only the existing failure
  states speak.
- **D4, the stripes for debugging.** (a) Delete the art entirely. The proof
  readout stays text only, and nothing reads the pixels. (b) Keep it behind
  `VIDEORC_PROOF_READOUT=1`.

## Not in this plan

- The inspector's own "Connecting…" pill, the "Starting Videorc's capture
  engine…" line under Record, and the status bar's "Connecting…" stay as
  they are. The Record line explains why Record is disabled. If the owner
  wants fewer copies of "Connecting", that is a follow-up.
- No fade-in on the native CAMetalLayer. That would change native-preview
  presentation for a cosmetic gain.
- The backend test pattern and the first-frame watchdog's budgets and heal
  ladder are unchanged.

## Slices

### S1: The proof surface paints nothing before its first frame (PR A)

- **Route:** Diagnose/Implementation, fit 9. **Lane:** `fable-5.1`. It
  changes what a preview surface shows on three platforms, so AGENTS.md's
  native-preview rules apply.
- **Files:** `apps/desktop/src/main/index.ts` (the surface page, the in-window
  and window hosts, the console-line observer). A small pure helper and its
  test go next to `in-window-proof-surface.ts`.

Steps:

1. In `nativePreviewSurfaceHtml`, make the `body` background transparent in
   every state. Delete the `--dot-x`, `--offset` and `--stripe-offset`
   writes in `tick()` and `presentLatestCompositorStatus` (D4 a). Keep the
   animation-frame tick and the measurement exactly as they are, because the
   smokes read `measuredFps` from them.
2. Let the stage show through while the page has no content:
   - **macOS and Linux** (the in-window `WebContentsView` from
     `createInWindowProofSurface`): the view's background is `#00000000`
     until the page has content, then `#101014`. The page reports content
     on its existing console-line channel, the plan 190 pattern behind
     `observeProofSurfaceLiveBackgroundLine`. It sends one new line,
     `[proof-preview] content live` or `content none`, whenever
     `surface-live` toggles, and main sets the view's background to match.
     If a transparent view proves unreliable under a Linux compositor, Linux
     keeps the opaque base. That is still better than today, because the
     stripes are gone. Record which way it went in the PR.
   - **Windows** (the separate opaque `BrowserWindow`, where transparency
     breaks on bad GPUs): use `setOpacity(0)` until there is content and
     `setOpacity(1)` after. Do not use `hide()`. The proof-surface role is
     background-throttled (`electron-background-policy.ts`), so a hidden
     window would starve the polling that Windows' first-frame and
     source-liveness contract depends on. Prove on the Windows host that
     the tick and polling cadence stay the same at opacity 0. If they do
     not, paint the plain `#101014` ground instead and say in the PR that
     Windows shows a dark stage, without the card, until the first frame.
3. Leave the native CAMetalLayer path alone. It only presents compositor
   frames, so the card underneath shows until the first present.
4. Change nothing in lifecycle reporting, the meaning of `surface-live`,
   first-frame budgets or stacking fields.

Tests:

- A pure `proofSurfaceHostBackground(contentLive, platform)` (or similar),
  tested for each platform.
- The new console line's parser, tested like the live-background line.
- A test that pins the surface document free of background art: no
  `radial-gradient` or `repeating-linear-gradient` on `body`.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`, `pnpm probe:preview-lifecycle`,
`pnpm smoke:preview-surface`, `pnpm smoke:preview-real-launch`. On Windows:
`pnpm smoke:windows-native-screen` on the Windows host.

**Done when** a 60 fps screen recording of a cold macOS launch, docked and
floating, has no blue or green frame. The stage shows the card underneath
(today's copy until PR B lands), then video. The probe and smokes are green.

### S2: The startup card in the stage (PR B)

- **Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5`. Read
  `.claude/skills/videorc-design/SKILL.md` first.
- **Files:** `components/preview-stage.tsx`, the Scene canvas in
  `tabs/layout-tab.tsx`, and a new pure `lib/preview-startup.ts` with its
  test.

Steps:

1. `lib/preview-startup.ts` exports one pure function. It takes
   `wsStatus`, the screen and camera preview statuses, the scene's source
   names, the supervisor state and how long the current step has run. It
   returns `{ step: 1 | 2 | 3, title, detail, stalled, action? }`, or
   `null` once a frame is presenting or a warning state owns the card.
2. One shared `PreviewStartupCard` component draws it: the title, the second
   line, three `Progress` segments and the optional fix button
   (`Button variant="outline"`). `DockedPreviewFrame` and the Scene canvas
   both use it in place of today's camera icon and "Waiting for the first
   frame…" text. `dockHiddenDisplay` reasons ("Placing preview…" and the
   rest) and the warning states keep priority, and none of their copy
   changes.
3. Add the breathing animation as a Tailwind utility in `styles.css`, with
   its `prefers-reduced-motion` override. Do not add a new component
   library.
4. Tests:
   - Every step, every stall and the warning-priority cases of the pure
     function.
   - A render test that the card shows the three segments with the right
     states.
   - Update the existing `preview-stage.test.ts` expectations for "Waiting
     for the first frame…".

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`. Check it by eye in the dark and light
themes (the stage is dark in both, but the strip around it is not). Per the
owner's rule for cosmetic work, no heavy smokes.

**Done when** a cold launch shows step 1, then 2, then 3, then video. Each
second line is true at that moment. Unplugging the camera before launch
stalls step 2 after 20 s with "Open Sources".

### S3: The floating Preview window says the same (PR B)

- **Route and lane:** as S2.
- **Files:** `apps/desktop/src/main/index.ts` (`PREVIEW_WINDOW_HTML`,
  `updatePreviewWindowWaitDetail`, the first-frame watchdog tick) and
  `src/main/window-palette.ts`.

Steps:

1. Port the step logic into a main-side pure helper, or share
   `lib/preview-startup.ts` through `src/shared/`, so that both windows say
   the same words. Sharing is preferred.
2. Replace "Waiting for preview" and `PREVIEW_WAIT_DETAIL_DEFAULT` with the
   step title and second line. Add the three segments in CSS from the
   palette tokens.
3. Keep the S4 (plan 024) rule: `null` hides the whole `.hint` block, so a
   z-order flash uncovers only the solid base.

Gates: as S2, plus `pnpm probe:preview-window`, because the floating
window's document changes.

**Done when** opening a floating Preview during startup shows the same steps
as the Studio card. No engineering words ("native surface", "compositor")
are left in the waiting copy.

## As built (2026-11-15)

- **S1** (built by the `fable` lane):
  - The surface page has no backdrop in any state. `proof-surface-content.ts`
    holds the line parser, `proofSurfaceViewBackground` and the page glue.
  - The page counts content as a live layer image or a drawn live-background
    canvas. It prints `[proof-preview] content live` or `content none` on
    each change and sets `body[data-proof-content]` for probes.
  - Main's `observeProofSurfaceContentLine` makes an `InWindowProofSurface`
    clear (`#00000000`) until there is content and `#101014` while there
    is. The view starts clear.
  - Windows' separate window is unchanged apart from the art.
  - The `preview-window-state` smoke command reports
    `surface.viewBackground`.
- **S2:**
  - `shared/preview-startup.ts` holds the steps, words and stall copy,
    shared with main.
  - `lib/preview-startup.ts` turns the capture choice and preview statuses
    into the sources to wait for.
  - `components/preview-startup-card.tsx` has `PreviewStartupCard`,
    `usePreviewStartupStalled` and `DockedPreviewStartup`. The last reads
    `useStudioPreview()` itself, so status ticks re-render the card and not
    the stage.
  - `dockedStageShowsStartup` in `preview-stage.tsx` decides when the card
    replaces the old text. The segment CSS is in `styles.css`.
- **S3:**
  - `main/preview-window-startup.ts` holds the hint's markup, CSS and repaint
    script, the compositor-status step and the stall clock.
  - `updatePreviewWindowHint` repaints only on a change, so the breathing
    step does not restart every tick.
  - Pending and healing ticks show the startup step. A fallback or a
    declared stall shows "Preview isn't showing" with the watchdog's reason
    and no segments.
