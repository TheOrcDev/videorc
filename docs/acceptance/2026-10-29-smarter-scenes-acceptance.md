# Scenes for your apps and Hide screen acceptance (plan 210), 2026-10-29

Scope: [plan 210](../../plans/210-scenes-for-your-apps-and-hide-screen.md),
S11: the end-to-end smoke, its gate and the docs, after S0 to S10. This is
automated dev-app evidence from the owner's Mac under other agents' load. It
is not a packaged take, not a real sign-in, not a real password manager, and
not a by-eye pass in either theme. Those are listed at the end as owed.

## Host

- macOS 26.5.1 (25F80), arm64; Node v24.22.1 arm64.
- Worktree `/Users/orcdev/projects/videorc-wt-210`, branch
  `plan-210-smarter-scenes`, head `7a126852` (S4's app-icon fix) plus S11.
- Host load during the runs: 4 to 12 (other agents compiled and ran dev apps
  on the same Mac). Every number here stretches with load, as S0 found.
- Evidence directories: `/tmp/smart-scenes-run8` to `/tmp/smart-scenes-run10`
  (`smart-scenes-summary.json`, per-frame JSON per output, `dev-app.log`).

## What the smoke proves

`pnpm smoke:smart-scenes` (`scripts/smoke-smart-scenes-app.mjs`, gates in
`scripts/lib/smart-scenes-gate.mjs`) launches the real macOS dev app through
`launchDevApp` on an isolated profile with the smoke command server, builds
and launches the two fixture apps (Fixture Alpha, red, 1280x720; Fixture
Beta, blue), and runs six steps on a 1920x1080@30 canvas with the camera off
and the Clips ring off except where a step needs it. It never goes live on a
real channel: the stream leg goes to a local FFmpeg RTMP sink.

1. **new-scenes.** On the Scene page, "New scene…" is clicked, both fixture
   cards are chosen in the picker and "Add 2 scenes" is pressed, all through
   the renderer's DOM. The gate wants one scene per fixture, named after it,
   with `app` (bundle id, name, `follows: true`), no display, and no `audio`.
2. **switches.** Beta's scene is edited into a shrunk freeform layout (so
   every switch also changes the layout and a wrong-layout frame is
   countable), then 20 switches A→B→A run while recording. The recording is
   decoded per frame (ffmpeg, 320x180 rgb24), aligned to the wall clock by
   Alpha's white flash at the start and the end (drift reported), and each
   switch gets click→first frame of the new window, old-window frames before
   the cut, black frames and wrong-layout frames. Gate: D5, p95 at most
   150 ms, zero black, zero wrong-layout, every cut seen.
3. **relaunch.** Fixture Beta is quit: applying its scene is refused and the
   program stays on Alpha. Beta is relaunched; once `devices.list` lists the
   new window, the scene switches to it. Gate: refused while gone, applied
   after, the window id changed and matches the relaunched window.
4. **follow.** Finder, then Beta, then Alpha, then Finder, then Videorc (when
   it is the only Electron app running) are brought to the front with `open`
   (LaunchServices, no Accessibility or Automation grant). `lsappinfo` is
   polled every 20 ms for the moment the OS made the app front; the recording
   gives the moment the new window's first frame reached the program. Gate:
   each switch within 400 ms settle + 150 ms switch + 100 ms observation
   slack (the poll and the follower's own tick), and no switch on Finder or
   Videorc.
5. **hide.** A record + stream session (custom RTMP at 6000 kbps to the local
   sink) with the Clips ring inside it. Hide screen is pressed on Studio's
   Screen row, held four seconds, Show is pressed, then `replay.save` writes a
   clip. The recording, the stream sink's FLV and the clip are each decoded
   and aligned by the flashes. A frame's sharpness is the share of
   neighbouring pixel pairs that jump by more than 200 (channel sum): live
   fixture frames measure 0.0012 to 0.0015, the frost measures 0 (the still
   is scaled to 48 rows, blurred and scaled back, so every edge is a ramp).
   Gate per output: every frame in the hidden span (after a 700 ms edge, up
   to 70 ms before Show for the clock anchor's one-frame quantization) is
   frosted (sharp at most 0.00015) and still; the frames before the hide and
   after Show are live (sharp at least 0.0006) and moving; the first frosted
   frame lands within 1 s of the press and the first live frame within 1 s
   of Show. The Screen file (separate source recordings) is checked the same
   way when the session can arm it.
6. **password-manager.** Both app scenes are removed, Display 1 goes on
   stream through the Screen picker path, and Fixture Beta is put on the
   password-manager list through the Scene page's "Add app…" picker. Beta to
   the front hides (reason `password-manager`) within the settle plus 600 ms;
   Finder to the front shows; then a manual Hide screen survives Beta coming
   to the front and leaving, and Show screen shows it.

Each step prints PASS, FAIL or SKIP with its numbers; the run exits 1 on any
FAIL. The whole smoke SKIPs, naming the grant, when the dev app has no Screen
Recording grant (New scene…, window capture and Hide screen all need it).

## Results

Ten runs were needed to shake the smoke itself out (tab ids, the RTMP cap,
the ring re-arming, the display pick). The last three runs are the evidence;
the table carries each step's numbers from the run that produced them.

| Step             | Run 8 (load 8.8→7.3)                                                               | Run 9 (load 4.1→5.3)                                                                             | Run 10 (load 4.6→4.4), every smoke fix in                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| new-scenes       | PASS                                                                               | PASS                                                                                             | PASS: "Fixture Alpha" and "Fixture Beta", app scenes, no audio                                                                           |
| switches         | **PASS** p50 97 / p95 145 / max 153 ms, black 0, wrong layout 0, cuts 20/20        | **FAIL** p50 125 / p95 152 / max 153 ms, black 0, **wrong layout 1**, cuts 20/20                 | **FAIL** p50 164 / p95 181 / max 186 ms, black 0, wrong layout 0, cuts 20/20                                                             |
| relaunch         | PASS, refused while quit, relaunched window applied in 100 ms (listed after 1.1 s) | PASS, applied in 174 ms (listed after 1.3 s)                                                     | PASS, applied in 84 ms                                                                                                                   |
| follow           | PASS, Beta 501 ms, Alpha 504 ms; Finder stayed; Videorc stayed                     | PASS, Beta 503 ms, Alpha 511 ms; Finder stayed; Videorc stayed                                   | PASS, Beta 476 ms, Alpha 440 ms; Finder stayed; Videorc stayed                                                                           |
| hide             | FAIL (the RTMP sink's port was taken by another client on this Mac; smoke fixed)   | PASS recording, stream and clip: 97/97 hidden frames frosted and still, hide +32 ms, show +27 ms | **PASS** recording, stream and clip: 98/98 hidden frames frosted and still, hide +0 ms, show +29 ms; Screen file SKIP (no camera)        |
| password-manager | FAIL (the ring stayed armed after the hide session; smoke fixed)                   | FAIL (the display pick's own settle check; smoke fixed)                                          | **PASS** Beta in front → hidden (password-manager) in 370 ms; Finder → shown; manual hide survives Beta in front and leaving; Show shows |

Run 10 exits 1 on the switch budget alone. Every other step passed in run 10,
and every step has passed at least once in the three runs; the switch step
passed in run 8.

### Switch latency against D5

The switch step's p95 sat between 145 and 181 ms across runs 8 to 10 on a
host at load 4 to 9 (one pass, two misses by 2 and 31 ms), and 264 to 348 ms at load 11 to 20 (runs 2 to 7). The
split from the backend's `[capture-generation]` lines in run 3: click →
backend begins the new capture 76 to 239 ms (p50 about 115 ms), then the
swap itself (both ScreenCaptureKit updates and the first frame) 30 to 70 ms.
S3 measured the renderer preflight at 18 to 35 ms for fixed-window scenes;
a scene made for an app also resolves the app's front window
(`sources.resolve_app_window`) before the switch, and that round trip is
what moves the p95 onto the budget line on a quiet host and past it on a
loaded one. Every switch went in place (the one `swap-fallback` in each run
is the first switch after launch).

One wrong-layout frame appeared in 1 of 20 switches in run 9 (Beta → Alpha,
one frame of Beta's shrunk picture drawn full-bleed before the cut) and in
run 2 under load 20 (7 frames on a `swap-fallback` switch, where the
stop-then-start path held the old picture but not the old layout). Runs 8 and
10 showed none. D5 asks for zero; this is an S3 follow-up, not a smoke
artefact: the frames are red at the centre with no border mark while the
incoming layout is full-bleed.

### Hide screen

The frost is total on every output the dev app can produce: 97 of 97 hidden
frames at sharp 0 (live frames 0.0012 to 0.0015) on the recording, the stream
leg and the clip, all still, with the first frosted frame 32 ms after the
press and the first live frame 27 ms after Show (one frame each at 30 fps).
The backend confirmed the hide in 3 ms and the show in 1 ms. The clip
(`replay.save`, 30 s requested, 12 s covered) carries the same span.

The Screen file is a named SKIP on this host: Separate source recordings
need a camera, and the dev app has no Camera grant (TCC). The Screen file
takes its frames from the same frosted publish point as the program (S7, at
the source), but it is not proven by pixels here; `pnpm
smoke:separate-source-take -- <combined>` on a packaged take with Hide
screen pressed is the owed check.

## Smoke notes worth knowing

- The default Clips ring (R2) re-arms itself as a buffer-only session after
  a session that carried `replay`, and restarts on every scene change while
  it runs. A running session pins the sources, so the smoke turns Clips off
  again through the Output switch's path and stops the ring's session before
  the display pick.
- `__videorcSmokeSelectFirstScreen` (the `select-screen-device` smoke
  command) keeps the previous scene's `app` on the working sources; the real
  Screen picker drops it. The follower ignores it with no saved scene on,
  so D11 is checked on the working display picture and no display scene is
  saved.
- The relaunched fixture's window is listed by `devices.list` about 1.1 to
  1.3 s after the app printed its ready line; a scene applied before that is
  refused with "Fixture Beta isn't open", which is the plan's "waits for the
  app's next window".
- D3's auto-save did not carry Beta's freeform edit into the saved scene
  within 3 s on any run; the smoke saves explicitly and says so in its log.

## Verification results

| Gate                                                                    | Result                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test scripts/lib/smart-scenes-gate.test.mjs`                    | PASS, 20/20                                                                                                                                       |
| `pnpm test:scripts`                                                     | PASS for every maintained test; one unrelated OBS-import smoke test (`setup timeout`) failed once under load and passed 12/12 alone               |
| `pnpm typecheck`                                                        | PASS                                                                                                                                              |
| Prettier on every changed file                                          | PASS                                                                                                                                              |
| `node scripts/check-em-dashes.mjs`, `node scripts/check-text-files.mjs` | PASS                                                                                                                                              |
| `pnpm smoke:smart-scenes`                                               | run 10: 5 of 6 steps PASS, switches FAIL on p95 181 ms > 150 ms (see Results)                                                                     |
| `pnpm smoke:scene-presets`                                              | FAIL before its first step on this host: "No camera device available to select." (the dev app has no Camera grant; the smoke is unchanged by S11) |
| `pnpm smoke:local-gates`                                                | not run in S11; the orchestrator runs the bundle once on the merged branch                                                                        |

## Owed: the owner's by-eye checks

- **T3 Code and Figma for real**, both themes: New scene… picks them, the
  rows read "T3 Code · front window" and "Figma · front window", ⌘-Tab
  between them follows within half a second with no black frame, a glance at
  Slack (no scene) changes nothing, and Figma relaunched overnight still
  works.
- **A real sign-in with Hide screen**: ⌃⌥H on a GitHub sign-in inside T3
  Code's browser; the "Screen hidden" chip in Studio and the Stream Manager;
  the recording, the vertical stream, a clip and the Screen file all frosted
  for those seconds; no text readable in the frost.
- **1Password** on a "Display 1" scene: opening it hides, closing it shows;
  a manual ⌃⌥H before opening it stays hidden after it closes.
- **A Stream Deck key** for a saved scene and for Hide screen.
- **Windows and Linux Hide screen runs** (D12): Ctrl+Alt+H on a display
  scene, the frost on the recording and the stream, the chip, and the
  macOS-only controls absent (not disabled).
- A packaged take with Separate source recordings on and Hide screen
  pressed, run through `pnpm smoke:separate-source-take`.
