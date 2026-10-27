# Plan 203: first-run setup, step 1: permissions

**Status:** SHIPPED IN PR 2026-10-27. S1 to S7 implemented. D1 and D4
were owner decisions; D2, D3 and D5 to D7 shipped as recommended and await
owner review. D8 was settled by the owner's by-eye on 2026-10-27: Polished
at Normal motion. S0 clean-account evidence, light and dark by-eye,
Windows acceptance and refused-row copy review remain owner-owed. See
`docs/acceptance/2026-10-27-first-run-permissions.md` for gate results and
outstanding checks. **Priority:** P1. Every new user meets this
first. Owner request: "a better onboarding for our users, only the first
time they are opening the app. And also some kind of button in settings
where they can start with their onboarding again. First and most basic, we
need to put in those permissions for camera, microphone, system audio, and
everything that we need. That's the first step that every user needs to do
when they enter Videorc. Let's make that one first perfect and then we are
going to think about next thing." Then: "use our liquid chrome background
that we have inside of Videorc. It can be on the background of our
onboarding and in the middle there can be some card with our permissions
for microphone, system audio, screen recording, and camera." **Size:** L:
one measurement slice on a clean Mac (S0), two logic slices (S1, S3), one
main/backend slice (S2), three UI slices (S4 backdrop, S5 Welcome card, S6
Settings) and one acceptance slice (S7). **Planned against:** Videorc
`origin/main` `28079a4d`, rechecked at `adee3866` for the live background
files (the shared checkout is weeks behind on `feat/windows-owner-waiver`;
work in a fresh worktree from `origin/main`). **Owner route:** Orchestrator
planned it (fit 10). Lanes per slice below, from `CLAUDE.md`.

## Goal

The first time someone opens Videorc, before anything else, the window
fills with Videorc's Liquid Chrome live background, moving slowly, and one
card in the middle gets every permission Videorc needs: Screen Recording,
System audio, Microphone and Camera. Each permission says why Videorc wants
it, asks with one click, and turns green the moment the OS says yes, with
proof where proof is cheap (the microphone's level moves). No OS prompt ever
appears before Videorc has explained it. A step the OS finishes only after a
relaunch says so and does the relaunch, and setup picks up where it left
off. Anyone can run it again from Settings.

The setup is built as a sequence of steps with one step today
(Permissions), so the next steps (sign in, destinations, a first
recording) slot into the same card over the same backdrop later, without a
second framework.

## What's wrong today (verified on `28079a4d`)

Renderer paths are under `apps/desktop/src/renderer/src/`.

1. **macOS asks before Videorc explains.** Main calls
   `primeScreenCapturePermission()` at launch (`main/index.ts:16164`, before
   `startBackend()`), and for a never-asked Mac it calls
   `desktopCapturer.getSources` (`:10172-10176`). That raises macOS's own
   Screen Recording prompt while the window is still loading. The backend
   then lists screens with
   `CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()`
   (`crates/videorc-backend/src/screen_capture.rs:539`), a second request
   path that runs on every device listing. Whether Clips (on by default,
   plan 199), the warm microphone (`keepMicrophoneWarm: true`) or the
   auto-started preview camera also open a device cold is not known: S0
   measures it.
2. **It only appears when a grant is missing.**
   `shouldShowPermissionsOnboarding` (`lib/system-access.ts:281-296`) hides
   it when every row is granted, so the first launch is not a first-run
   moment at all.
3. **Any close is forever.** The dialog's `onOpenChange` calls `onComplete`
   on Escape or a click outside
   (`components/permissions-onboarding-dialog.tsx:57`), which writes
   `videorc.onboardingComplete` (`components/app-shell.tsx:354-357`). One
   stray click and it never comes back.
4. **No way back in.** Plan 174 S3.17 removed "Set up permissions" from
   Settings (`components/settings/permissions-settings.tsx:13-17`). Nothing
   reopens the flow.
5. **System audio is invisible.** On macOS system audio rides the Screen
   Recording grant (ScreenCaptureKit audio,
   `crates/videorc-backend/src/devices.rs:416-425`), which macOS 15 and
   later call "Screen & System Audio Recording". There is no System audio
   row; the Screen Recording row mentions it only in its purpose line
   (`lib/system-access.ts:225-234`).
6. **The screen can't be asked for in place.** `systemAccessAction` sends
   the screen row to System Settings every time
   (`lib/system-access.ts:173-181`). On a never-asked Mac, Videorc isn't in
   that list yet, so the user lands on a list without Videorc in it (only
   the cold prompt from point 1 ever adds it).
7. **Relaunch: the code disagrees with itself.** Sources says "then quit and
   reopen Videorc" because "macOS reads the grant once per launch"
   (`lib/source-permissions.ts:103-107`). The 07-06 checklist says the grant
   watcher (`main/system-permission-watch.ts`, 90 checks at 1 s, then a
   backend restart) flips the row with no relaunch, a box nobody ticked
   (`docs/acceptance/2026-07-06-permissions-onboarding.md`). S0 settles it.
8. **Which name to turn on.** Sources names the capture helper
   (`capturePermissionTargetName`, the `videorc-backend` binary in a
   packaged build, `main/runtime-info.ts:136-138`) and offers "Show helper
   in Finder"; onboarding and Settings imply "Videorc". Only one of them is
   what macOS lists. S0 settles it.
9. **Smokes would be blocked.** 57 scripts launch the dev app on a fresh
   profile through `launchDevApp` → `smokeAppEnv`
   (`scripts/lib/app-launcher.mjs:164`, `:341`), and about ten seed the
   onboarding key. Today that's harmless because the dev Mac has every
   grant. A setup that shows on every first launch would sit in front of
   all of them.
10. **Existing users.** Anyone who had every grant never saw the dialog, so
    they have no `videorc.onboardingComplete`. A "first launch" rule on that
    key alone would greet thousands of existing users after an update. Every
    launch since 2026-07-02 writes `videorc.whatsNewLastSeenVersion`
    (`lib/whats-new.ts:8`), which marks an existing install.
11. **Windows and Linux.** Windows has camera and microphone switches under
    one "Let desktop apps access…" umbrella, no screen grant, and system
    audio through loopback where the build supports it (`devices.rs`
    `windows_system_audio_supported`). Linux keeps no standing grants; the
    desktop portal asks per capture, and Settings shows "Nothing to grant
    here".
12. **Nothing else needs a grant today.** No Accessibility, Input Monitoring
    or Local Network use in `apps/desktop/src` or the backend (no
    `AXIsProcessTrusted`, `IOHIDCheckAccess`, Bonjour or
    `NSLocalNetworkUsageDescription`). Notifications are the updater's only
    (`main/updater.ts:281`) and macOS asks for them on its own. Documents
    and Downloads are asked when someone picks such a folder. So "everything
    we need" is: Screen & System Audio Recording, Microphone and Camera on
    macOS; Microphone and Camera on Windows.

What already works and stays: the shared row derivation
(`systemAccessRows`) and list (`SystemAccessList`) used by onboarding,
Settings and Sources; camera and microphone asked in place with the native
prompt and the backend restart after a fresh grant (`main/media-access.ts`);
the focus refresh; What's New waiting while setup is open
(`app-shell.tsx:626`); the privacy line "Recordings stay on this Mac. Cloud
AI only runs after you opt in."

## The Liquid Chrome background today (verified on `adee3866`)

- **What it is.** One of the ten live backgrounds (plan 190, ported from
  React Bits by David Haz with the author's permission), with three looks:
  Polished, Gold and Mercury (`docs/live-backgrounds.md`,
  `apps/desktop/src/shared/live-backgrounds.catalog.generated.json`).
  Polished and Mercury are black and white chrome, the logo's own material;
  Gold is warm. The GLSL source of truth is
  `crates/videorc-backend/src/live_background/glsl/liquid_chrome.frag`.
- **A WebGL2 player already exists.**
  `apps/desktop/src/shared/live-background-webgl.js` (plain JavaScript, an
  IIFE that sets `globalThis.VideorcLiveBackground`) runs all ten from
  `shared/live-backgrounds.render.generated.json` (260 KB, about 30 KB
  gzip) with the backend's uniform packing and size rules.
  `shared/live-background-clock.js` is the phase clock: Calm is half speed,
  and a clock starts at the look's poster phase, so the first moving frame
  is the poster.
- **Only the Preview uses it.** The Electron proof surface (Windows idle
  preview, Linux preview) inlines both files as text
  (`main/preview-surface-live-background.ts`, `?raw` imports). It keeps the
  poster `<img>` as the first frame and the fallback, names a still reason
  (`software-gpu`, `shader-compile-failed`, `gpu-budget`…), and pauses while
  `document.hidden`. The main window shows posters only (Assets →
  Backgrounds tiles); nothing in it runs WebGL.
- **Posters.** `assets/backgrounds/live-liquid-chrome-{polished,gold,mercury}.webp`
  (about 60 KB each) and 384 × 216 thumbnails under `live-thumbs/`.
- **Cost.** On an Apple M4 through Metal: 0.3 to 0.9 ms per 1080p frame and
  0 to 2 MB of scratch (`docs/live-backgrounds.md`). WebGL in the main
  window has never been measured.
- **The eager renderer budget is nearly full** (about 5 KB of headroom on
  2026-10-23, `pnpm check:renderer-assets`). The player, the clock and the
  render JSON must load lazily with setup.
- **The design skill forbids it today.** "Inside a window there are no
  floating panels, no shadows, and no big cards", "no page column", and
  "no wallpaper underlays" (that rule is about faking glass). Setup needs a
  new owner call (S7 writes it): the one surface with a live background
  behind the UI and its content in a centred card.

## Owner decisions

Recommendations are pre-filled; the executor uses them unless the owner
changes them.

- **D1. Where setup lives. DECIDED (owner, 2026-10-27).** A full-window
  Welcome inside the main window: while setup is open it replaces the
  sidebar and the page, the Liquid Chrome live background fills the window
  edge to edge, and the setup sits in one card in the middle. The title
  band keeps the traffic lights and the drag region. Nothing behind it is
  half-working (no Studio full of "permission required" alerts), no preview
  opens behind it, and the next steps reuse the card. Every word sits inside
  the card: bright chrome can't carry text at a readable contrast.
- **D2. Who sees it.** **Recommended:** every fresh install, once, even when
  the Mac already has every grant (a reinstall shows the step all green;
  one click). Existing installs never see it on update (S1 migration). The
  alternative is today's rule: skip it when nothing is missing.
- **D3. What blocks Continue.** **Recommended: nothing.** Screen Recording
  and Microphone carry a "Needed to record" tag, Camera an "Optional" tag,
  System audio none (it comes with Screen Recording). The primary reads
  "Continue" once both needed rows are granted, and "Skip for now" before
  that. Skipping is always possible; a setup that traps someone is worse
  than a gap Sources already explains.
- **D4. Four rows. DECIDED (owner, 2026-10-27).** The card lists Screen
  Recording, System audio, Microphone and Camera, in that order (grant
  order: System audio sits under the grant it rides on).
  - **macOS:** System audio has no button of its own. Its line says
    "Comes with Screen Recording." and it turns green with that grant,
    refined by the backend's System audio device (so an unsupported Mac
    says why). Two buttons doing the same thing would confuse. The Screen
    Recording row's line names the pane as macOS names it: "Screen &
    System Audio Recording" on macOS 15 and later, "Screen Recording"
    before.
  - **Windows:** Screen Recording and System audio are fact rows ("Windows
    doesn't ask for this.", Ready; System audio shows the backend's reason
    on a build without loopback). Microphone and Camera keep their switch
    line.
- **D5. The Settings button.** **Recommended:** Settings → General, a new
  section "Setup" under Stream Manager for column balance holding one `SettingsRow`: label "First-run setup",
  description "Go through the welcome steps again, starting with
  permissions.", button **"Run setup again…"**. ⌘K lists the same command.
  It's disabled with "Finish your recording or livestream first." while a
  recording or livestream runs. Settings → Permissions keeps its list (the
  one home for the live state) and gains nothing new.
- **D6. Proof.** **Recommended:** once the microphone is granted, its row
  shows the live level bar (`MicLevelMeter`) and "Say something. The bar
  moves when Videorc hears you." The granted Camera row names the camera
  found ("FaceTime HD Camera"). No camera picture and no System audio meter
  in this plan (see Out of scope).
- **D7. The name.** **Recommended:** the card's title is "Welcome to
  Videorc"; the flow is **first-run setup** in the glossary and in
  Settings, `first-run` in code. "Setup" alone already names the sidebar
  group and Livestream → Setup.
- **D8. The look. DECIDED (owner by-eye, 2026-10-27): Polished, Normal
  motion, the same look in both themes.** Mercury at Calm did not read as
  live. Dim 30% under dark, none under light; higher contrast adds 20% Dim.

## What the user will see

macOS, first launch, nothing granted yet:

```
 ● ● ●   ~~~~~~~ Liquid Chrome, Polished, Normal, edge to edge ~~~~~~~
~~~~~~~~~~  ┌─────────────────────────────────────────────────────┐  ~~~~~~~~~~
~~~~~~~~~~  │ [icon 64]  Welcome to Videorc                       │  ~~~~~~~~~~
~~~~~~~~~~  │ First, let Videorc record your Mac. macOS asks      │  ~~~~~~~~~~
~~~~~~~~~~  │ once for each, and you can change them later in     │  ~~~~~~~~~~
~~~~~~~~~~  │ Settings → Permissions.                             │  ~~~~~~~~~~
~~~~~~~~~~  │                                                     │  ~~~~~~~~~~
~~~~~~~~~~  │ Screen Recording   [Needed to record]     Allow…    │  ~~~~~~~~~~
~~~~~~~~~~  │ Record your displays and app windows.               │  ~~~~~~~~~~
~~~~~~~~~~  │ ─────────────────────────────────────────────────── │  ~~~~~~~~~~
~~~~~~~~~~  │ System audio       [Not asked yet]                  │  ~~~~~~~~~~
~~~~~~~~~~  │ The sound your Mac plays: games, music and          │  ~~~~~~~~~~
~~~~~~~~~~  │ calls. Comes with Screen Recording.                 │  ~~~~~~~~~~
~~~~~~~~~~  │ ─────────────────────────────────────────────────── │  ~~~~~~~~~~
~~~~~~~~~~  │ Microphone         [Needed to record]     Allow…    │  ~~~~~~~~~~
~~~~~~~~~~  │ Your voice in recordings, livestreams and           │  ~~~~~~~~~~
~~~~~~~~~~  │ captions.                                           │  ~~~~~~~~~~
~~~~~~~~~~  │ ─────────────────────────────────────────────────── │  ~~~~~~~~~~
~~~~~~~~~~  │ Camera             [Optional]             Allow…    │  ~~~~~~~~~~
~~~~~~~~~~  │ Put yourself in your scenes.                        │  ~~~~~~~~~~
~~~~~~~~~~  │                                                     │  ~~~~~~~~~~
~~~~~~~~~~  │ Recordings stay on this Mac. Cloud AI only runs     │  ~~~~~~~~~~
~~~~~~~~~~  │ after you opt in.                                   │  ~~~~~~~~~~
~~~~~~~~~~  │                                                     │  ~~~~~~~~~~
~~~~~~~~~~  │                                  [Skip for now]    │  ~~~~~~~~~~
~~~~~~~~~~  └─────────────────────────────────────────────────────┘  ~~~~~~~~~~
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

- **The backdrop** is Liquid Chrome in the D8 look, moving at Normal speed,
  covering the whole window under the title band. The poster shows on the
  first frame and the motion continues from it without a jump. With Reduce
  motion on, a GPU in software mode or WebGL unavailable, the poster stays
  as a still: setup looks the same, it just doesn't move.
- **The card** is the dialog tier (`glass-float-dialog`: opaque, a 1 px rim,
  the drop shadow, `rounded-panel`, `p-5`), the `lg` dialog width (576 px),
  centred. It never grows past the window less 16 px a side; the rows
  scroll inside it when the window is small. It follows the app theme (the
  dark solid or porcelain), over the same backdrop.
- **Inside the card:** the app icon (64 px, as in About), the title as the
  window's `h1`, the description, one `GroupedList` of the four rows, the
  privacy line, and the footer. The footer has ONE primary: "Continue" when Screen
  Recording and Microphone are granted, otherwise "Skip for now". S3
  resolved the original two-button mock to this changing label.

Each row moves through these states. One status chip and at most one
button per row, from `SystemAccessList`:

| State                                 | Chip                         | Line under the purpose                                                                  | Button                     |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| Not asked yet                         | Not asked yet (neutral)      | none                                                                                    | Allow… (the native prompt) |
| Waiting on System Settings            | Waiting (neutral, spinner)   | "Turn on {name} in System Settings → Privacy & Security → {pane}, then come back here." | Open System Settings…      |
| Needs a reopen                        | Reopen needed (warn)         | "macOS turns this on after Videorc reopens."                                            | Reopen Videorc             |
| Checking (Videorc restarting capture) | the last known chip, spinner | none                                                                                    | none                       |
| Granted                               | Granted (good)               | Microphone: the level bar and its line (D6); Camera: the camera's name                  | none                       |
| Not granted (refused)                 | Not granted (warn)           | "System Settings is blocking {thing}. Turn on {name} there."                            | Open System Settings…      |
| Restricted (policy)                   | Not granted (warn)           | "Restricted by macOS policy and may not be changeable here."                            | none                       |
| Granted, no device                    | Device issue (warn)          | "Granted, but no camera is connected."                                                  | none                       |

- System audio on macOS shows its grant's chip and never a button (D4).
- `{name}` is whatever S0 proves macOS lists ("Videorc", or "Electron" in
  the dev app).
- Every word goes through `docs/ui-copy.md` and its guards; the owner can
  change copy at the by-eye.
- Windows: the same backdrop and card, "First, check that Windows lets
  Videorc use your camera and microphone.", with the four rows of D4.
- Linux: no automatic setup in this plan (nothing to grant). "Run setup
  again…" shows the same backdrop and card with today's "Nothing to grant
  here" text and Continue.
- Granted everywhere (a reinstall): every chip is green, Continue is the
  only thing to press.
- Continue or Skip for now: the card and backdrop go away and the app opens
  on the Studio. Neither can happen by accident; Escape does nothing.
- Quitting or relaunching mid-setup: the next launch opens setup again at
  Permissions.
- From Settings: the same screen; Continue returns to Settings.

## Slices

Each slice leaves `main` shippable. Write and commit every slice first, then
run the Rust build, the e2e smokes and the bundle once at the end (owner
rule). Unit tests run with their slice.

### Slice S0: measure first launch on a clean Mac (no product change)

**Why first:** points 1, 7 and 8 above decide what S2 builds. Reading the
code can't settle them; macOS TCC behavior can only be measured.

**Route / lane:** Diagnose, fit 9, `fable-5.1`. Attended: it needs a Mac
with no Videorc grants.

**Where:** a new standard macOS user account on the owner's Mac (TCC grants
are per user, so the owner's own grants stay intact), or the lab Mac. Never
`tccutil reset` the owner's own account without the owner's go in the
session. Use the latest packaged build from `/Applications` (the real
bundle id `dev.theorcdev.videorc`), and the dev app once for the
"Electron" case.

**Record, for the packaged app and the dev app:**

1. Every OS prompt that appears before any click, in order, with what
   raised it: main's `primeScreenCapturePermission`, the backend's
   `CGRequestScreenCaptureAccess` in device listing, Clips arming, the warm
   microphone, the preview camera. Read the backend log next to each
   prompt.
2. The name macOS lists under Privacy & Security → Screen & System Audio
   Recording after the request ("Videorc" or "videorc-backend"), and under
   Camera and Microphone.
3. After turning Screen & System Audio Recording on while Videorc runs:
   does macOS show "Quit & Reopen"? If the user clicks "Later", does the
   grant watcher's backend restart make screens list as available, and does
   System audio capture actually produce samples (`pnpm smoke:system-audio`
   case or a 10 s recording checked with ffprobe), all without a relaunch?
4. The same for a grant made while Videorc is in the background for more
   than 90 s (past the watcher's window), then brought to the front.
5. Camera and Microphone: the prompt in place, the backend restart, and how
   long the rows read wrong during that restart.
6. The macOS version (`sw_vers`), and the same checks on macOS 15 if the
   account is on 26, or the reverse, if a second Mac is available.

**Output:** a dated acceptance note,
`docs/acceptance/2026-10-xx-first-run-permissions-s0.md`, with the table of
prompts, names and relaunch answers. Paste the summary into this plan's
execution notes.

**Done when:** each of the six questions has a measured answer or a stated
reason it couldn't be measured.

**STOP** if macOS lists the capture helper (`videorc-backend`) as its own
entry that the user must find and add by hand. That's a packaging change
(the helper inside the app bundle, or spawned so Videorc is responsible)
and needs its own owner decision before S2.

### Slice S1: the first-run record and the gate (renderer logic)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** new `lib/first-run.ts` and `lib/first-run.test.ts`;
`lib/capture.ts` (`STORAGE_KEYS`); `components/app-shell.tsx` (the gate);
`main/runtime-info.ts` and `shared/backend.ts` (`RuntimeInfo`);
`scripts/lib/app-launcher.mjs` and its test; the ten scripts that seed the
old key (they keep working, see below).

**Changes:**

1. A versioned record under a new key `videorc.firstRun`:
   `{ version: 1, status: 'in-progress' | 'done' | 'skipped' | 'existing-install', step: 'permissions', updatedAt }`.
   `FIRST_RUN_STEPS = ['permissions'] as const`. A later step appends to the
   list; the record says which steps were seen, so a future step can be
   offered to people who finished an older setup (a decision for that plan,
   not this one).
2. `firstRunDecision({ record, legacyOnboardingValue, whatsNewLastSeen, suppressed, platform })`,
   pure: `'show' | 'hide'`.
   - No record, no legacy key, no What's New key: a fresh install, `show`
     (D2; Linux `hide`, nothing to grant).
   - No record, but either old key present: an existing install. Write
     `existing-install` once and `hide`. This keeps every seeded smoke and
     `scripts/live-lab/lib/seed.mjs` working unchanged.
   - `in-progress`: `show`, at its step (resume after a quit or a relaunch).
   - `done`, `skipped`, `existing-install`: `hide`.
   - `suppressed`: `hide`, and write nothing.
3. Read the record and the two old keys **once, synchronously, before the
   first render** (module scope in the shell), because `useWhatsNew` writes
   its key on the first launch and would otherwise turn a fresh install
   into an "existing" one. A unit test pins this order.
4. The smoke switch: `RuntimeInfo.firstRunSuppressed`, set from
   `VIDEORC_SMOKE_SKIP_FIRST_RUN=1`; `smokeAppEnv` sets it by default, and a
   smoke opts out with `{ VIDEORC_SMOKE_SKIP_FIRST_RUN: '0' }`. Check that
   `RuntimeInfo` has no strict validator that would drop the field (the
   strict contract trap applies to backend status fields; confirm it
   doesn't apply here).
5. Wire the gate to the decision with today's dialog still in place, so the
   slice ships on its own. The dialog no longer completes on Escape or an
   outside click (point 3): only its buttons write the record.

**Verification:** `pnpm --filter @videorc/desktop test` (new decision
matrix, order test, existing `system-access.test.ts`), `pnpm test:scripts`
(launcher default), `pnpm typecheck && pnpm lint`.

**Done when:** a fresh profile shows the dialog once even with every grant,
a profile holding either old key never does, a smoke launched through
`launchDevApp` never does, and quitting mid-dialog shows it again.

### Slice S2: no cold prompts, the screen asked in place, and Reopen (main and backend)

**Route / lane:** Implementation, fit 9, `fable-5.1` (main process, Rust and
macOS TCC; high risk on the first launch).

**Files:** `main/index.ts` (`primeScreenCapturePermission`, the IPC handlers
near `:15271`, the grant watcher wiring), `main/media-access.ts`,
`main/system-permission-watch.ts` and tests, `preload/index.ts`,
`shared/backend.ts` (`MediaAccessSnapshot`, the preload API),
`crates/videorc-backend/src/screen_capture.rs`, and whatever S0 shows
raising a prompt cold (Clips arming, the warm microphone, the preview
camera).

**Changes (final shape follows S0):**

1. **Nothing asks at launch.** `primeScreenCapturePermission` keeps its log
   line and stops calling `desktopCapturer.getSources`. Backend device
   listing preflights only: `screen_capture_access_granted()` drops
   `CGRequestScreenCaptureAccess`. Every path S0 caught opening a device
   cold checks the grant first and waits instead of asking.
2. **The screen asked in place.** `MediaAccessSnapshot` gains
   `screen: MediaAccessStatus` (macOS: `getMediaAccessStatus('screen')`;
   Windows and Linux: `'not-applicable'`). A new IPC
   `system:request-screen-access` makes the request from the identity S0
   proved macOS lists, and starts the grant watcher. It returns the status
   after the request.
3. **The watcher outlives 90 s while setup is open.** Renderer focus and the
   watcher both re-read the status; a grant noticed late still restarts
   capture once.
4. **Reopen.** A new IPC `app:relaunch-for-permission`: refused while a
   recording or livestream runs, otherwise `app.relaunch()` and the normal
   quit path (the backend shuts down through its owned PIDs, never a
   process scan). Only used where S0 showed a restart of capture isn't
   enough.
5. Sources' and Settings' screen row get the same in-place "Allow…" when the
   screen is never asked, so someone who skipped setup isn't stranded on a
   System Settings list without Videorc in it.

**Verification:** desktop unit tests for the IPC policy
(`media-access.test.ts`, `system-permission-watch.test.ts`, new request and
relaunch tests); `cargo fmt --check --all`;
`cargo clippy -p videorc-backend -- -D warnings`; targeted
`cargo test -p videorc-backend screen_capture devices`; then, at the end of
the plan, `pnpm smoke:recording-studio` (device listing is capture
selection) and `pnpm smoke:system-audio`. Repeat S0's first-launch check on
the clean account: zero prompts before a click.

**Done when:** a clean account sees no OS prompt until it presses Allow…,
the screen request lists Videorc under the name S0 found, and a granted
screen reaches available screens (and System audio samples) either live or
through Reopen, as S0 decided.

**STOP** if dropping the request from device listing breaks screen capture
for an already-granted user in any smoke. Report the failing smoke; don't
paper over it with a request.

### Slice S3: the rows say everything (renderer logic)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `lib/system-access.ts`, `lib/system-access-view.ts`,
`lib/source-permissions.ts` and their tests;
`lib/system-permission-orchestration.ts`.

**Changes:**

1. The four rows of D4. Screen Recording's state from the exact `screen`
   status first (like camera and microphone), refined by the backend's
   device evidence; its waiting line names the pane by macOS version
   (`runtimeInfo.osRelease`: Darwin 24 and later is macOS 15+, "Screen &
   System Audio Recording"; earlier "Screen Recording").
2. A new `system-audio` row: on macOS it mirrors the Screen Recording grant,
   refined by the backend's System audio device (`devices.rs`
   `system_audio_device_for`), and never has an action. On Windows both
   Screen Recording and System audio are fact rows (Ready, or the backend's
   reason). Settings → Permissions and Sources read the same rows.
3. New states, derived, never stored: `waiting` (a Settings round trip is
   open for this row), `needs-relaunch` (granted at the OS, capture still
   refused after the restart, per S0), `checking` (capture is restarting
   after a grant; the row keeps its last known chip so nothing flashes red).
   Inputs: the pending pane, the restart boundary already used by
   `isReplacementPermissionClient`, the relaunch answer from S2.
4. `required` per row (D3), the chip words in the table above, and the
   primary's label: "Continue" once every required row is granted, "Skip
   for now" before.
5. The camera row's granted detail names the camera found; Sources' alert
   copy and its "Show helper in Finder" follow S0's name answer.

**Verification:** desktop unit tests: a state matrix per platform (macOS 14
and 15 pane names, the System audio row following its grant, Windows with
and without system audio, Linux empty), every transition in the table,
"checking" never reading not-granted; `pnpm typecheck && pnpm lint`.

**Done when:** the matrix is green and Settings → Permissions and Sources
read the new rows with no UI change beyond the words and the System audio
row.

### Slice S4: the Liquid Chrome backdrop (UI)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`. Read the whole
`.claude/skills/videorc-design/SKILL.md` and `docs/live-backgrounds.md`
first. Independent of S0 to S3: it can run in parallel.

**Files:** new `lib/live-background-player.ts` and its test (a typed
wrapper over the shared player and clock), new
`components/first-run/welcome-backdrop.tsx` and its test. Read only, never
edited: `shared/live-background-webgl.js`, `shared/live-background-clock.js`,
`shared/live-backgrounds.render.generated.json` (they serve the Windows and
Linux preview).

**Changes:**

1. **Load lazily.** The backdrop, the two shared scripts and the render
   JSON load in the setup chunk only; the eager gzip budget is 405,000 bytes
   (raised from 400,000 during execution). The
   wrapper imports the two scripts for their side effect and reads
   `globalThis.VideorcLiveBackground` and `VideorcLiveBackgroundClock`
   with types. If an import needs a change to a shared file (an ES export,
   `this` under ESM), make the smallest behavior-free change and run the
   preview surface live background tests and `pnpm probe:preview-lifecycle`.
2. **Poster first.** The D8 look's poster fills the window at once (an
   `<img>`, `object-fit: cover`). The shell paints the solid window tone
   while the setup chunk loads, so the first frame is never bare glass. The
   canvas fades in (150 ms) after its first drawn frame; the clock starts at
   the poster phase, so the motion continues from the picture.
3. **Draw.** The player draws `liquid-chrome`, Polished, Normal, with the
   theme's Dim; the canvas is the window's size times `devicePixelRatio`,
   and the canvas's long side is capped at 1920 device pixels. The player
   resizes on its next frame and resets the guard's timing window.
4. **Cheap by design.** At most 30 frames a second (a time gate in
   `requestAnimationFrame`); decoration never needs more. Paused while the
   document is hidden (`hooks/use-document-visible.ts`) and while the window
   is minimized. When setup closes, the runner is disposed and the GL
   context released (`WEBGL_lose_context`): nothing is left allocated, as
   with a live background that is off.
5. **Still instead of moving**, the poster kept and the reason logged once
   to the console (never UI copy): `prefers-reduced-motion: reduce`;
   hardware acceleration off or a GPU fallback active (`runtimeInfo`); a
   software renderer (`WEBGL_debug_renderer_info` naming SwiftShader or
   llvmpipe); no WebGL2; a shader that fails to compile; a lost context; and
   a budget guard like the backend's: if the median frame interval over 3 s
   passes 50 ms, drop to the player's `half` level, and if it stays over,
   show the poster for the rest of setup.
6. **Out of the way.** `aria-hidden`, no pointer events; the drag region
   stays the title band. `prefers-contrast: more` adds 20% Dim.
7. **A DOM contract for the smoke:** `data-first-run-backdrop="moving|still"`
   and `data-first-run-backdrop-reason` on the backdrop's root.

**Verification:** unit tests for the pure parts (the still decision, the
frame gate, the guard's two steps, theme to look and Dim);
`pnpm check:renderer-assets` (the eager size unchanged; record the setup
chunk's size); `pnpm typecheck && pnpm lint`; the preview surface live
background tests if a shared file changed. Measured cost, recorded for the
acceptance doc: frames drawn per second and the GPU process's CPU over 30 s
with setup open, on the owner's Mac and on the Windows tester's machine.
Screenshots of Polished, Mercury and Gold in both themes for the D8 by-eye.

**Done when:** behind an empty setup shell the backdrop moves smoothly in
both themes, each still case shows the poster with its reason, and nothing
of it is allocated after setup closes.

### Slice S5: the Welcome card (UI)

**Route / lane:** UI/Product Design, fit 9, `fable-5.1`. Read the whole
design skill and `docs/ui-copy.md` first. This is the app's first
impression; the owner's by-eye polish after it runs on `opus-5.5`.

**Files:** new `components/first-run/first-run-setup.tsx`,
`components/first-run/permissions-step.tsx`;
`components/system-access-list.tsx` (a `variant="setup"` that adds the
required tag, the microphone's level bar and the Reopen button; Settings
keeps the plain variant); `components/app-shell.tsx`; delete
`components/permissions-onboarding-dialog.tsx` once nothing imports it.

**Changes:**

1. While setup is open the shell renders `FirstRunSetup` instead of the
   sidebar and the page, inside the same providers (backend, devices, the
   meter): the S4 backdrop under the whole window, the title band with its
   drag region and the traffic-light gutter (`useTrafficLightGutter`), and
   the card centred in what's left.
2. The card: the dialog tier (`border glass-float-dialog`,
   `rounded-panel`, `p-5`, the drop shadow), the `lg` dialog width through
   the same size token `DialogContent` uses (no hand-set width: the dialog
   guard's rule applies), at most the window less 16 px a side, with the
   rows region scrolling. Inside: the app icon (64 px), the title as the
   window's `h1`, the description, one `GroupedList` of the four rows, the
   privacy line, and the footer with ONE primary: "Continue" when the needed
   rows are granted, otherwise "Skip for now" (outline).
   Built only from shared primitives (`GroupedList`, `StatusBadge`, `Badge`
   for the tags, `Button`, `Spinner`, `MicLevelMeter`); no new widget.
3. The shell's chords, ⌘K and the status bar shortcuts are off while setup
   is open (Stream Manager and Notes don't open over it). What's New keeps
   waiting.
4. The Preview stays closed and auto-preview waits until setup closes,
   since the Studio isn't mounted. Verify with the preview lifecycle probe.
5. Focus lands on the first row that has a button. Enter presses the
   primary. Screen readers hear each row's name, chip and line
   (`aria-live="polite"` on the chip so a grant is announced). The card is
   the page's `main` landmark.
6. Continue and Skip for now write the record (`done` or `skipped`), and the
   card and backdrop fade out (150 ms) to the Studio. Pressing Allow… writes
   `in-progress` first, so a relaunch resumes here.
7. Light and dark both (owner rule): the card follows the theme over the D8
   backdrop. `prefers-reduced-transparency` and `prefers-contrast: more`
   through the existing tokens.

**Verification:** desktop unit tests (the shell renders setup or the
workspace from the decision; buttons write the record; Escape does
nothing); `renderer-style-guards`, `renderer-copy-guards`,
`renderer-shortcut-guard`; `pnpm typecheck && pnpm lint && pnpm format:check`;
`pnpm build`; `pnpm check:renderer-assets`; `pnpm probe:preview-lifecycle`;
`pnpm probe:ui-glass --gate` with setup closed (unchanged windows), and
screenshots of the card over the moving backdrop in both themes (the card
tier must read as its token whatever the chrome behind it shows).

**Done when:** the screen matches "What the user will see" in both themes on
macOS, and in a Windows CI or tester screenshot.

### Slice S6: run it again from Settings and ⌘K (UI)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`.

**Files:** `components/settings/general-settings.tsx` (or the file that
renders Settings → General's sections), the ⌘K command list,
`lib/workspace-navigation.ts` if it owns the opener,
`components/app-shell.tsx`.

**Changes:**

1. Settings → General gets the "Setup" section with the D5 row and button.
   ⌘K gets "Run setup again…".
2. Opening it from Settings shows setup in replay mode, backdrop and card
   included: the record isn't reset, Continue and Skip for now return to
   Settings (⌘K: to the page the person came from).
3. While a recording or livestream runs, the button is disabled with
   `DisabledReason` "Finish your recording or livestream first." and ⌘K
   hides the command.

**Verification:** desktop unit tests (replay returns to the opener, locked
while a session runs); `settings-layout.test.ts`; the copy and style
guards; `pnpm typecheck && pnpm lint`.

**Done when:** the button opens setup with live rows, returns to Settings,
and is locked during a session.

### Slice S7: smoke, docs and acceptance

**Route / lane:** Implementation, fit 7, `gpt-6.1-sol`.

**Files:** new `scripts/smoke-first-run-app.mjs` and a pure gate in
`scripts/lib/` with its test; `package.json` (`smoke:first-run`); the
design skill (the owner call below, and the shadcn mapping row "First-run
setup: the Liquid Chrome backdrop and one card on the dialog tier");
`docs/live-backgrounds.md` (the Welcome screen as a fourth place the player
runs); `docs/ui-copy.md` (replace the "Set up permissions…" ellipsis example
with "Run setup again…"); `CONTEXT.md` (the glossary entry "first-run
setup"); a dated acceptance doc; `plans/README.md`.

**The owner call for the design skill:** "**First-run setup paints Liquid
Chrome** (2026-10-27, plan 203). The Welcome screen is the one surface with
a live background behind the UI: Liquid Chrome, Polished, Normal motion,
edge to edge, dimmed under dark, with setup in one centred card on the dialog tier. The backdrop is
opaque and makes no glass claim; it is decoration and never carries text.
Every other window rule stands."

**The smoke (dev app, macOS; it opts out of the S1 suppression):**

1. A fresh isolated profile: setup shows in first-run mode with four resolved
   rows, an in-progress record and no sidebar. Launch logs are retained;
   the clean-account S0 pass is the proof of no cold OS prompts.
2. Measured from setup mount, the backdrop reaches moving within 3 s (the
   2 s plan target plus 1 s of honest dev-loading and observation slack).
   A 2.1 s screencast has at least ten changing frames, different first and
   last PNGs, and measured backdrop draws stay at or below 31 fps. Any
   unexpected still fails with its reason.
3. CDP reduced-motion emulation produces a still with reason
   `reduced-motion`; clearing it restores motion.
4. The one primary writes done or skipped as its label promises, mounts the
   workspace, removes the canvas and releases retained backdrop contexts.
   Grants are observed, never requested by the smoke.
5. Reload on the same profile: no setup, finished record unchanged.
6. Only the What's New key seeded: no setup; record becomes existing-install.
7. An in-progress record resumes setup.
8. Settings → General → Run setup again… opens replay; the primary returns
   to Settings, and the record is byte-for-byte unchanged on entry and exit.
9. With an old What's New version and an in-progress record, no What's New
   dialog appears over setup during a continuous observer watch.

The not-asked, waiting, refused and reopen paths need a clean account; S3's unit matrix covers them and the owner's clean-account pass proves
them.

**Owner clean-account checklist (the real first-run proof):**

- [ ] New macOS user, packaged build: no OS prompt before a click.
- [ ] The backdrop moves smoothly behind the card in both themes; the D8
      look is right.
- [ ] Each Allow… raises exactly one native prompt; Allow turns the row
      green; System audio turns green with Screen Recording; the
      microphone's bar moves when speaking.
- [ ] Screen & System Audio Recording: the round trip through System
      Settings and back, with Reopen if S0 needs it; setup resumes after the
      reopen.
- [ ] Deny each one: the row reads Not granted with Open System Settings…,
      and turning it on there flips it on return.
- [ ] Skip for now with gaps: the Studio opens, Sources explains the gaps
      with "Allow…" for a never-asked screen.
- [ ] Run setup again… from Settings, in both themes.
- [ ] An existing install updated to this build sees no setup.
- [ ] Windows tester: the backdrop (moving, or the poster with its reason),
      the four rows, and the desktop-apps switch line.

**Verification:** `pnpm test:scripts`, `pnpm smoke:first-run`, then the
bundle once: `pnpm smoke:local-gates`.

**Done when:** the smoke passes, the docs are updated, and the acceptance
doc lists every gate with its result, the S4 cost numbers, and the
checklist with what's owed.

## Verification summary

| Slice | Gates                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0    | Measurements on a clean account; acceptance note                                                                                                                   |
| S1    | desktop unit tests, `pnpm test:scripts`, typecheck, lint                                                                                                           |
| S2    | unit tests, `cargo fmt`, clippy, targeted `cargo test`; at the end `smoke:recording-studio`, `smoke:system-audio`, the clean-account recheck                       |
| S3    | desktop unit tests (platform state matrix), typecheck, lint                                                                                                        |
| S4    | unit tests, renderer asset budget, typecheck, lint; measured fps and GPU CPU on macOS and Windows; three-look screenshots; preview probes if a shared file changed |
| S5    | unit tests, style/copy/shortcut guards, build, renderer asset budget, `probe:preview-lifecycle`, `probe:ui-glass --gate`, screenshots both themes                  |
| S6    | unit tests, settings layout test, guards                                                                                                                           |
| S7    | `smoke:first-run`, `test:scripts`, `smoke:local-gates`                                                                                                             |

## Edge cases

- **The grant lands after 90 s in System Settings.** The focus re-read and
  the longer watcher (S2.3) still catch it; the row moves from Waiting to
  Checking to Granted.
- **macOS's own "Quit & Reopen" is pressed.** macOS quits Videorc; the
  `in-progress` record reopens setup on the Permissions step, now green.
- **"Later" in macOS's dialog.** The row reads Reopen needed with Reopen
  Videorc (if S0 shows capture needs it).
- **Capture restarts after a camera or microphone grant.** Rows read
  Checking with their last chip; never a red flash.
- **Videorc can't start capture at all** (no FFmpeg, a crash loop). Camera,
  Microphone and Screen Recording states come from the OS
  (`MediaAccessSnapshot`), so the step still works; device proof waits, and
  the Health door stays reachable after Continue. The backdrop doesn't
  depend on capture.
- **No camera or no microphone connected** (a Mac mini). The grant can still
  be given; the row reads Device issue with the line, and Camera is
  optional.
- **Managed Macs.** Restricted rows say so and offer no button.
- **The dev app.** Copy names "Electron" where macOS does, from
  `runtimeInfo`.
- **A weak or software GPU** (an old Windows laptop, a VM). The guard drops
  to half size, then to the poster; setup itself never waits on the
  backdrop.
- **Reduce motion, or Reduce transparency.** The poster stays still; the
  card is already opaque.
- **System Settings in front of Videorc.** The window may be partly hidden,
  not minimized: the 30 fps cap keeps the cost small while the grant is
  made, and the backdrop pauses when the window is minimized or hidden.
- **A tiny window.** The card keeps 16 px from each edge and its rows
  scroll; the backdrop covers whatever size the window is.
- **Setup open, then a global shortcut or a phone remote.** A fresh install
  has no paired remotes; global shortcuts are inactive until setup closes.
- **A smoke that needs setup.** It passes `VIDEORC_SMOKE_SKIP_FIRST_RUN=0`.
- **Two Videorc windows on first launch** (Stream Manager restore). None
  restores on a fresh profile; S5 keeps them closed while setup is open.

## STOP conditions

- S0: macOS lists the helper as a separate entry the user must add by hand.
- S2: an already-granted user's screen capture breaks without the request in
  device listing.
- S4: the shared player can't run in the main window without a change that
  alters what the Windows or Linux preview draws. Report it; the preview's
  live background is plan 190's contract.
- S5: the native preview shows over setup, or auto-preview can't be held
  without touching preview lifecycle code beyond a gate. Report the probe
  output; preview lifecycle changes need their own plan.
- Any slice: an existing install would see setup after updating.

## Out of scope

- The next setup steps (sign in, destinations, a first recording, Buddy).
  The step list, the card and the backdrop are ready for them; each needs
  its own plan.
- A live background anywhere else in the app's own UI. Setup is the one
  exception (D1).
- Letting the streamer pick the setup's background or look.
- A live camera picture in the Camera row, and a live System audio meter (it
  only reads while a session bus runs, plan 201 D3).
- Accessibility, Input Monitoring and Local Network: nothing in Videorc uses
  them today (point 12). If Phone remote turns out to raise Local Network on
  macOS 15, that prompt belongs to its pairing flow.
- Notifications, and Documents and Downloads folder access: macOS asks at
  first use, in context.
- The macOS periodic "keep allowing screen recording" reminders: OS
  behavior, nothing to build.
- Any change to Settings → Permissions beyond the shared rows.

## Risks

- **The first launch is the riskiest launch.** A gate bug could trap a new
  user behind setup. Skip for now is always enabled, and the decision is a
  pure, fully tested function.
- **Removing the launch prompt** could strand someone who skips setup on a
  System Settings list without Videorc. S2.5 puts Allow… on Sources and
  Settings for a never-asked screen.
- **TCC differs by macOS version.** S0 measures one or two versions; record
  which, and keep the Reopen fallback even if live grants work on them.
- **The backdrop's cost on the first launch.** WebGL in the main window has
  never been measured, and a fresh install's first minute is when a weak
  PC is busiest (the backend starting, the performance check). The 30 fps
  cap, the guard and the poster bound it; S4 measures it on Windows before
  S5 builds on it.
- **The shared player serves the Windows and Linux preview.** S4 reads it
  and never changes what it draws; any edit runs the preview probes.
- **Contrast.** Bright chrome behind the card's rim and shadow: the D8 Dim
  and the by-eye in both themes settle it.
- **Smokes.** One default in `smokeAppEnv` covers the 57 fresh-profile
  scripts; a script that builds its env without `smokeAppEnv` would hit
  setup. Grep for `spawn(` on the dev app outside the launcher in S1.
- **Existing users.** The migration relies on What's New's key, written on
  every launch since 2026-07-02. Older installs that never launched a
  version since then would see setup once, which is acceptable.

## Original execution order (historical)

1. `git fetch origin && git worktree add -b plan-203-first-run ~/projects/videorc-wt-203-exec origin/main`
   (never the shared checkout).
2. Read `AGENTS.md`, this plan, and for S4 to S6 the whole design skill and
   `docs/ui-copy.md` (S4 also `docs/live-backgrounds.md`).
3. S0 first, with the owner (it needs a clean macOS account). S1 and S4 can
   start in parallel: neither depends on S0.
4. S3 waits for S0's answers and the owner's D2, D3 and D5 to D8.

## Execution notes

Committed slices, from `git log --oneline adee3866..HEAD` (oldest first):

- `baf9caa4`: docs(plans): plan 203, first-run setup step 1: permissions on Liquid Chrome.
- `1bab9247`: S1, a versioned first-run record and gate.
- `d0d439a5`: S2, nothing asks at launch; screen asked in place; Reopen.
- `b012962f`: S4, the Liquid Chrome backdrop.
- `78af8c9a`: S3, four rows that say everything.
- `68020fae`: S4 fix, each player owns its canvas; Polished at Normal.
- `f6a72eb7`: S5, the Welcome card on Liquid Chrome.
- `04243c5f`: S6, Run setup again… in Settings → General and ⌘K.

S7 adds the smoke, its pure gate/tests and acceptance docs without app
source changes. The orchestrator reviews and commits this slice.

Execution deviations and settled choices:

- Eager renderer gzip budget: 400,000 → 405,000 bytes.
- New IPC `app:workspace-shown`: main restores the launch Preview window
  only once the workspace shows.
- Clips does not start while setup is open.
- StrictMode reused a canvas with a lost WebGL context, leaving the backdrop
  still. Found and fixed by giving each player its own canvas.
- D8 owner by-eye, 2026-10-27: Polished at Normal shipped; Mercury at Calm
  did not read as live.
- Setup sits under Stream Manager in General for column balance, rather
  than being the last section.
- Remote-control intents are not gated during replay. The recording and
  livestream lock still controls entry to replay.
- S3 resolved the original footer mock to ONE primary, labelled Continue
  or Skip for now from the required permission rows.
- D2, D3 and D5 to D7 shipped as recommended; the owner still owes review.
- Every surface names Videorc (`permissionTargetName`), and the Sources
  alert no longer offers "Show helper in Finder" (S3, `9bcf01d3` fixed its
  stale test). That follows this plan's working answer to question 8; if S0
  finds macOS lists `videorc-backend` as its own entry, the STOP above
  applies and the helper reveal comes back with the packaging change.
- The smoke allows 3,000 ms from setup mount to moving, with 1,000 ms slack
  over the 2,000 ms target. It measures backdrop draws separately from
  screencast delivery, since card and microphone updates can produce frames.

S0 clean-account measurements are still owed. No cold-prompt, main-identity,
system-audio grant or Reopen result is inferred from this host's smoke.
Gate results and remaining acceptance are recorded in
`docs/acceptance/2026-10-27-first-run-permissions.md`.
