# Plan 260, Windows testing: how to test the GPUI app on your PC

This document is for the outside contributors who test Videorc's new
desktop app on Windows. It goes with
[plan 260](260-gpui-rewrite.md) (the rewrite of the Electron app in GPUI)
and with the [Windows code plan](260-gpui-rewrite-windows-code.md) (the
Windows code slices). You do not need to know Videorc's internals: every
step below says what to run, what you should see, and what to send back.

**Your run counts as the physical Windows pass.** Videorc has no Windows PC
of its own. The owner decided on 2026-11-23 that all three platforms switch
to the GPUI app together, with Windows tested on a real PC and no waiver,
and that the two Windows contributors are that PC. A run counts when it
comes with the evidence in [Sending evidence](#sending-evidence) and the
owner has reviewed it. This is the rule Videorc already uses for
contributor runs (plan 220, P4-D6).

## Ground rules

- **Real hardware only.** Windows 11 x64, build 22000 or newer, not a
  virtual machine, plugged into AC power for every timed run.
- **Never share secrets or personal data.** No passwords, tokens, stream
  keys, email addresses, chat contents from real viewers, file paths with
  your user name, serial numbers or MAC addresses, in a comment, a
  screenshot, a log or a recording. Use the test profile below, never your
  own Videorc account or stream keys, unless a step asks for a sign-in and
  says how. The bug form's rules apply here too
  (`.github/ISSUE_TEMPLATE/windows-alpha-bug.yml`).
- **Never commit raw evidence.** Screenshots, recordings and logs go in a
  PR or issue comment as attachments, not into the repository.
- **Every check gets one verdict:** `PASS`, `FAIL` or `BLOCKED`. `BLOCKED`
  means you could not run it (say why); it is never a soft pass. A step
  that has no physical device it needs (a microphone, a camera) is
  `BLOCKED`, never passed with a fake one.
- **Expected results are the bar.** If what you see differs from
  "Expected" in any way, it is a `FAIL` with a note, even if it seems
  minor. Maintainers decide what matters.
- **One machine per report.** If both of you run the same check, send two
  reports.

## Your machine

Record these once and repeat them at the top of each report (the public
part only):

| Field | Example | Public? |
| --- | --- | --- |
| Windows edition and build | Windows 11 Pro 24H2, build 26100.2314 | Yes |
| CPU | Intel Core i5-8250U | Yes |
| GPU and driver version | Intel UHD 620, 31.0.101.2125 | Yes |
| RAM | 16 GB | Yes |
| Display(s): resolution, scale, refresh | 1920×1080, 125 %, 60 Hz | Yes |
| Camera and microphone (kind, not serial) | USB webcam, USB microphone | Yes |
| Machine make and serial, your user name | | **No, never** |

It helps when the two contributors' PCs differ: one with integrated
graphics (Intel or AMD) and one with a discrete GPU (NVIDIA or AMD), and
at least one display above 100 % scale.

## One-time setup

1. Install **Git for Windows** (<https://git-scm.com/download/win>).
2. Install **Visual Studio 2022 Build Tools**
   (<https://visualstudio.microsoft.com/downloads/>, "Build Tools for
   Visual Studio 2022") with the workload **Desktop development with C++**.
   Keep its default **MSVC** and **Windows 11 SDK** components ticked: GPUI
   compiles its shaders at build time with `fxc.exe`, which comes with the
   Windows SDK.
3. Install **Rust** with `rustup` (<https://rustup.rs>), the default
   `stable-x86_64-pc-windows-msvc` toolchain.
4. Install **Node.js 24** (<https://nodejs.org>), then in a new PowerShell:

   ```powershell
   corepack enable
   ```

5. Get the code and the pinned tools (the same steps as
   [docs/windows-dev-loop.md](../docs/windows-dev-loop.md) "One-time
   setup"):

   ```powershell
   git clone https://github.com/TheOrcDev/videorc.git
   cd videorc
   corepack install
   pnpm install
   pnpm ffmpeg:fetch:windows
   ```

**Expected:** every command exits without an error. `pnpm install` may take
several minutes the first time.

6. Check the shader compiler GPUI needs:

   ```powershell
   Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter fxc.exe | Select-Object -First 1 FullName
   ```

   **Expected:** one path ending in `x64\fxc.exe`. If none is found, rerun
   the Build Tools installer and add the Windows 11 SDK. If GPUI's build
   later says it cannot find `fxc.exe`, set
   `$env:GPUI_FXC_PATH = '<that full path>'` and build again.

7. Optional, for the preview checks: **PresentMon** from
   <https://github.com/GameTechDev/PresentMon/releases> (the console
   version). The spikes print their own numbers; PresentMon is a second
   opinion on frame pacing when a maintainer asks for one.

### A clean test profile

Every run uses a throwaway data folder, so nothing touches a Videorc you
may have installed and no real account is used:

```powershell
$test = "$env:TEMP\videorc-gpui-test"
Remove-Item $test -Recurse -Force -ErrorAction SilentlyContinue
$env:VIDEORC_APP_DATA_DIR = "$test\app-data"
$env:VIDEORC_USER_DATA_DIR = "$test\user-data"
```

These are the same two variables Videorc's own test harnesses use to
isolate the app and its backend. Set them in every PowerShell window you
start the app from. A step that needs a different profile says so. (Until
the GPUI app exists, in Phase 2, only the spikes run, and they keep no
data.)

### Folder for your evidence

Keep evidence on your PC in this layout, outside the repository:

```text
%USERPROFILE%\videorc-evidence\
  <slice>\                 for example S0.2c
    <yyyy-mm-dd>-run<N>\   one folder per run
      summary.json         the line the spike prints, saved as a file
      screenshots\         PNG, named <check>-<what>.png
      logs\                the files the step names
      recording.mp4        when the step asks for a screen recording
      notes.md             anything you noticed, in plain words
```

To take a screenshot of one window: Alt+PrtScn, then paste into Paint and
save as PNG. To record the screen: the Snipping Tool's video mode
(Win+Shift+R), saved as MP4.

## How the spikes are built and run

Phase 0 is a set of small throwaway programs ("spikes") that answer one
question each before the real app is built. They live on the branch
`spikes/gpui` of this repository, one folder per spike under
`spikes/gpui/`, each with a README. They are never merged into `main`.

```powershell
cd videorc
git fetch origin
git switch spikes/gpui
git pull
cd spikes\gpui
cargo build --release -p <spike-name>
cargo run --release -p <spike-name> -- --seconds 40
```

The first build compiles GPUI and takes 10 to 30 minutes; later builds take
seconds to a few minutes. Every spike:

- opens its own window and closes itself after `--seconds`;
- prints one line that starts with `[spike] summary ` followed by JSON, and
  writes the same JSON to `summary.json` in the folder you ran it from;
- prints `[spike] error ` and exits non-zero if something failed.

Copy `summary.json` into your evidence folder after each run. Don't move or
cover the spike's window during a timed run, keep other heavy programs
closed, and keep the PC on AC power: CPU numbers only mean something on an
unobstructed window.

To read processes' CPU from outside (when a step asks for it), paste this
function once into the second PowerShell you measure from. It reads each
process's CPU time every 2 seconds through `Get-Process`, so it works on
any Windows display language (performance-counter names such as `% Processor
Time` are translated on non-English Windows; this avoids them):

```powershell
function Measure-VideorcCpu {
  param([string[]]$Names, [int]$Seconds, [string]$Out)
  New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
  'time,process,pid,cpu_percent_of_one_core' | Set-Content $Out
  $prev = @{}
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $last = 0.0
  while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
    Start-Sleep -Seconds 2
    $now = $clock.Elapsed.TotalSeconds
    foreach ($p in Get-Process -Name $Names -ErrorAction SilentlyContinue) {
      if ($prev.ContainsKey($p.Id)) {
        $pct = [math]::Round(($p.CPU - $prev[$p.Id]) / ($now - $last) * 100, 1)
        "$(Get-Date -Format o),$($p.ProcessName),$($p.Id),$pct" | Add-Content $Out
      }
      $prev[$p.Id] = $p.CPU
    }
    $last = $now
  }
}
```

The numbers are a percentage of one core (200 means two cores busy). Report
them as they are, with your PC's logical processor count
(`[Environment]::ProcessorCount`) in the report.

## Phase 0 checks, per slice

The slice numbers match [plan 260](260-gpui-rewrite.md). The code for each
spike comes from the [Windows code plan](260-gpui-rewrite-windows-code.md);
this section is only how to test it.

### S0.2a: GPUI builds and runs on Windows

Spike `spike-hello` (from code slice WC-0.1).

1. Build it from a clean `target` folder and time the build:

   ```powershell
   Remove-Item target -Recurse -Force -ErrorAction SilentlyContinue
   Measure-Command { cargo build --release -p spike-hello } | Select-Object TotalMinutes
   ```

2. Run it: `cargo run --release -p spike-hello -- --seconds 20`.

**Expected:** a window with a sidebar on the left and a content pane, a
translucent box and pill drawn over a colour that changes every second;
the window resizes smoothly when you drag its edge; the summary has
`"renders"` above zero and `"errors": 0`.

**Send:** build minutes, the target folder's size
(`(Get-ChildItem target -Recurse | Measure-Object Length -Sum).Sum / 1GB`),
`summary.json`, one screenshot at 100 % scale and one at your highest
scale (Settings > System > Display > Scale), and whether the text looks
sharp at both.

### S0.2b: the backend hands its preview over

The backend's half of routes (a) and (b) (plan 260 S0.2b), checked on your
GPU before your spike uses it. No spike is needed: these tests make the test
process its own app. They duplicate every handle into themselves, open the
shared textures on a second D3D11 device and read the pixels back (route
(b)), and open the composition surface on a DirectComposition device of
their own while the backend presents into it at two sizes (route (a)).

1. Get `main` and run the hand-over tests (the first build takes 10 to 30
   minutes):

   ```powershell
   cd videorc
   git switch main
   git pull
   New-Item -ItemType Directory -Force "$env:USERPROFILE\videorc-evidence\S0.2b\$(Get-Date -Format yyyy-MM-dd)-run1\logs" | Out-Null
   cargo test -p videorc-backend --bin videorc-backend preview_handover -- --test-threads=1 2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\S0.2b\$(Get-Date -Format yyyy-MM-dd)-run1\logs\tests.txt"
   ```

**Expected:** the run ends with `test result: ok.` and `0 failed`, and the
list includes these two, each `ok`:

- `windows_d3d11_preview_handover::runtime::tests::preview_handover_shared_texture_reaches_a_second_device_with_its_pixels`
- `windows_d3d11_preview_handover::runtime::tests::preview_handover_composition_surface_presents_and_opens_in_the_app`

On a PC with two GPUs (integrated and discrete), run it once more with the
app's GPU preference set to the other one (Settings > System > Display >
Graphics), and send both.

**Send:** `tests.txt`, your machine table, and which GPU ran it (Task
Manager > Performance shows the GPU that was busy).

The cross-process check, a real app taking each route from a running
backend, is part of S0.2c: your `spike-preview-windows` opens the hand-over
as the [code plan](260-gpui-rewrite-windows-code.md) describes ("Taking the
hand-over") and reports its numbers there.

### S0.2c: the Windows preview routes, measured

Spike `spike-preview-windows` (from code slices WC-0.2 to WC-0.5). It runs
the real Videorc backend recording your display (a real D3D11 capture
session, not a test pattern: the backend hands over only that session's
preview, and a test pattern or a 4K60 output answers
`preview-handover-unavailable`) and shows its preview in a GPUI window by
one of four routes:

| `--route` | What it is |
| --- | --- |
| `a` | A native view: the backend's video in a DirectComposition visual beneath GPUI's content |
| `b` | GPUI's renderer draws the backend's shared texture each frame |
| `c` | The backend's own preview window placed over the GPUI window |
| `d` | CPU frames from shared memory, drawn by GPUI as an image |

For each route, three runs of 10 minutes each at 1440p60, then one at 4K30
(the largest sizes the hand-over serves; 4K60 is refused):

```powershell
cargo run --release -p spike-preview-windows -- --route a --resolution 1440p --fps 60 --seconds 600
cargo run --release -p spike-preview-windows -- --route a --resolution 4k --fps 30 --seconds 600
```

Route (d) has no backend writer yet: until it does, its runs use the spike's
own synthetic producer, and the summary says so.

While it runs, in the PowerShell where you pasted `Measure-VideorcCpu`
(change the route and run number in the file name each time):

```powershell
Measure-VideorcCpu -Names 'spike-preview-windows','videorc-backend' -Seconds 600 -Out "$env:USERPROFILE\videorc-evidence\S0.2c\cpu-route-a-run1.csv"
```

Then, with the spike still running for each route:

1. Drag the window around and resize it for 20 seconds. **Expected:** the
   video stays inside its rounded frame, never lags behind the window by
   a visible amount, never shows a black or garbage frame.
2. Hover the drawn handles over the video. **Expected:** the translucent
   box and label draw over the video, not under it.
3. Start a screen share or a recording of the whole screen in another app
   (for example the Snipping Tool's video mode, Teams or OBS) with the
   floating preview window open (`--floating`). **Expected:** the floating
   preview window is not in that capture (it is hidden from capture), and
   the main window is.
4. Minimise and restore. **Expected:** the video comes back within one
   second.

**The summary's numbers and the pass lines** (the same as the macOS check,
S0.1):

| Field in `summary.json` | Pass line |
| --- | --- |
| `cpu_copies_per_frame` | 0 for routes a, b and c (d copies by design: report it) |
| `present_interval_p95_ms` | ≤ 20 at 60 fps; at 4K30, report it against the 33.3 ms frame interval |
| `ui_cpu_percent_still` (app process, scene not changing) | ≤ 3 |
| `ui_cpu_percent_live` (app process, video moving) | ≤ 10 |
| `gpu_ms_per_frame_p95` | ≤ 2 |
| `ui_redraws_per_second_idle` (no UI change, video moving) | ≤ 2 for routes a, c and d (the UI must not redraw per video frame). Route b redraws the window for every video frame by design: report its number and its CPU cost, don't mark it FAIL on this line |
| `dropped_frames` | report it |

**Send:** per route, the three `summary.json` files, the CPU CSVs, a
screenshot of the docked and the floating window, a 30-second screen
recording of step 1, and the verdict for steps 1 to 4. Maintainers use
these numbers to pick the route (plan 260 decision D12).

### S0.4: the look on Windows

Spike `spike-chrome` (the macOS look spike, ported). Run it in dark and in
light mode (Settings > Personalization > Colors), and once with a contrast
theme (Settings > Accessibility > Contrast themes > Aquatic).

**Expected:** buttons, switches, sliders and the round red Record button
look like the macOS screenshots in the spike's README: same colours, same
corners, no jagged or blurry edges, text sharp at 100 % and at your highest
scale.

**Send:** one screenshot per appearance and scale, and a note on anything
that looks different from the README's macOS screenshots.

### S0.5: text

Spike `spike-text`.

1. **Japanese input.** Add Japanese in Settings > Time & language >
   Language & region, switch to it (Win+Space), click the spike's text
   field and type `nihongo` then Space then Enter. **Expected:** the
   candidate window appears next to the caret, and `日本語` lands in the
   field. Repeat with the Chinese (Pinyin) keyboard: `zhongwen` → `中文`.
2. **Emoji.** Press Win+. and pick three emoji. **Expected:** they draw in
   colour, not as boxes or black outlines.
3. **Selecting text.** Drag across a chat message, press Ctrl+C, paste into
   Notepad. **Expected:** exactly the selected text.
4. **The long chat.** The spike fills 10,000 chat rows with animated
   emotes. Scroll with the mouse wheel and by dragging the scrollbar for 30
   seconds. **Expected:** smooth scrolling, emotes animate, and the summary
   shows `scroll_fps_p5 ≥ 55`, `extra_memory_mb ≤ 100`,
   `first_paint_ms ≤ 100`.

**Send:** a verdict per step, screenshots of steps 1 and 2, `summary.json`.

### S0.6: Narrator and the test driver

Spike `spike-a11y`.

1. Turn on Narrator (Ctrl+Win+Enter). Tab through the spike's list and its
   dialog. **Expected:** Narrator reads every control's name and role
   ("Record, button"; "Microphone, slider, 70 percent"), and the dialog's
   title when it opens.
2. Run the spike's driver check:
   `cargo run --release -p spike-a11y -- --driver-check`.
   **Expected:** it prints `[spike] driver found Record button by role and
   name` and `[spike] driver clicked Record`.

**Send:** a verdict per step and a screen recording of step 1 with sound
(Narrator's voice is the evidence).

### S0.7: desktop integration

Spike `spike-desktop`. Each item: **Expected** as written, verdict each.

| # | Check | Expected |
| --- | --- | --- |
| 1 | The title bar | The minimise, maximise and close buttons work; hovering maximise shows Windows 11's snap layouts; double-clicking the header maximises |
| 2 | A global shortcut | With another app in front, Ctrl+Alt+Shift+R prints `[spike] hotkey` |
| 3 | A deep link, cold | With the spike closed, Win+R → `videorc-spike://hello` starts it and it prints the link |
| 4 | Single instance | Starting it a second time focuses the first window; the second exits and the first prints the second's arguments |
| 5 | Hidden from capture | The window marked "hidden" is absent from a screen recording; the other is present |
| 6 | Keep on top | The "on top" window stays above other apps |
| 7 | Sleep guard | While the spike says "keeping awake", `powercfg /requests` (in an admin PowerShell) lists it under DISPLAY |
| 8 | A system notification | A Windows notification appears with the spike's name |
| 9 | Files | The open dialog, "Show in folder" and drag-and-drop of a file onto the window all work |

### S0.8: spike-room build

Plan 260 S0.8 measured LiveKit's Rust SDK as the talk-show host on a Mac
(spike `spike-room`; the results are in its pull request,
[#1742](https://github.com/TheOrcDev/videorc/pull/1742)). The Mac cannot
cross-build it for Windows, so this check is one native build on your PC.
It needs no camera, microphone or room: only the build.

1. Get the spike and build it twice, with and without the LiveKit SDK (the
   first build downloads a 109 MB WebRTC library and takes several minutes):

   ```powershell
   cd videorc
   git fetch origin
   git switch spikes/gpui
   git pull
   cd spikes\gpui\spike-room
   Measure-Command { cargo build --release } | Select-Object TotalMinutes
   (Get-Item target\release\spike-room.exe).Length / 1MB
   cargo build --release --no-default-features
   (Get-Item target\release\spike-room.exe).Length / 1MB
   ```

**Expected:** both builds finish without an error; the first size is tens
of megabytes larger than the second.

**Send:** the build minutes, both sizes in MB (the first is with the SDK,
the second without), and your machine table. If a build fails, send the
last 50 lines of its output (`cargo build --release 2>&1 | Select-Object
-Last 50`).

### S0.9: build and start-up

From the S0.2a build: the clean build minutes and target size. Then start
the spike five times with the window closed in between and send the
`startup_to_first_paint_ms` values from each `summary.json`.

### S0.10: today's Electron app, as the baseline

Install the newest **Videorc Windows Alpha** from the website, sign in only
if a step needs it, and take screenshots of each page and window listed in
the [Windows parity checklist](#windows-parity-checklist) in dark and light
mode. These are what the GPUI app is compared against later. Use the test
profile; don't sign in to your own streaming accounts.

Then measure the CPU cost of the Electron app, the line the GPUI app's
"Performance on your PC" row is compared with. Same scene for both: the
Studio page open with your camera and your main display as the sources
(the default first scene), the window not covered, on AC power.

1. **Idle:** the app open on the Studio page, not recording, for 5
   minutes.
2. **Live:** press Record with the default settings and keep recording for
   5 minutes, then stop.

For each, in the PowerShell where you pasted `Measure-VideorcCpu`, started
when the step starts (`Videorc*` matches the app's processes and
`videorc-backend`):

```powershell
# step 1, idle:
Measure-VideorcCpu -Names 'Videorc*' -Seconds 300 -Out "$env:USERPROFILE\videorc-evidence\S0.10\cpu-idle.csv"
# step 2, live:
Measure-VideorcCpu -Names 'Videorc*' -Seconds 300 -Out "$env:USERPROFILE\videorc-evidence\S0.10\cpu-live.csv"
```

**Send:** the two CSVs, the recording's resolution and frame rate (from
the Output page), and the screenshots.

## Phases 1 to 5: the checks after Phase 0

The GPUI app itself starts in Phase 2. From then on you run the real app,
not spikes, on the `main` branch:

```powershell
git switch main
git pull
pnpm install
$env:VIDEORC_APP = 'gpui'
pnpm dev
```

(The exact command is fixed by plan 260's slice S2.1, which updates this
section when it lands.) **Expected:** the main window opens, and within a
few seconds its status bar shows the backend as ready.

| When | What you run | Send |
| --- | --- | --- |
| Each Phase 1 slice that changes Windows behaviour in today's app (stream graphics, meters, settings) | The smokes the slice's PR names, with the Electron dev app (`pnpm dev`, no `VIDEORC_APP`), as [docs/windows-dev-loop.md](../docs/windows-dev-loop.md) describes | The smoke's last 30 lines and its verdict |
| Phase 2: the shell (S2.1, S2.3b, S2.6b) | The app opens; the preview on the chosen route, docked and floating; the S0.7 table against the real app | As in S0.2c and S0.7 |
| Phase 3: each screen, after its macOS PR merges | The screen's rows of the [parity checklist](#windows-parity-checklist), by eye against your S0.10 baseline shots, in dark, light and a contrast theme, at 100 % and your highest scale; the screen's smokes with `VIDEORC_APP=gpui` | A table of rows with a verdict each, the screenshots side by side, the smoke output |
| Phase 4: the gate | `pnpm smoke:local-gates:windows` with `VIDEORC_APP=gpui`, then a 10-minute recording and a 10-minute stream to a private test destination the maintainers give you | The gate's report, the app's logs, a screen recording of the start and end of each |
| Phase 5: the switch | Install a signed Electron build, then let it update itself into the signed GPUI app | Every setting, scene and sign-in kept; a screen recording of the update |

The app's logs are in the `logs` folder of the user-data folder:
`$env:VIDEORC_USER_DATA_DIR\logs\` with the test profile, or
`%APPDATA%\Videorc\logs\` for an installed app (`backend.log` and the
app's own log). Zip the folder and remove any line with a path holding your
user name before sending.

## Windows parity checklist

The full list, one line per control, is generated from the code into
`docs/gpui/parity.md` (plan 260 slice S0.11); its Windows column is yours.
Until it exists, this is the outline. A row passes when it works as in
today's Electron app on Windows, by eye in dark, light and a contrast
theme, reachable by keyboard, and read by Narrator.

**Windows-only rows** (on top of every row in plan 260's "What parity
means"):

- [ ] Scale: 100 %, 125 %, 150 % and 200 %, and moving a window between two
      displays with different scales: no blurry text, nothing cut off.
- [ ] Title bar: Windows' own minimise, maximise and close buttons and snap
      layouts; the window frame and saved window positions after restart.
- [ ] Dark, light and contrast themes follow Windows' setting live.
- [ ] Text input: Japanese and Chinese IME in the chat composer, Notes and
      every text field; emoji with Win+.; Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z;
      right-click Cut, Copy and Paste.
- [ ] Narrator: every control named, dialogs announced, lists navigable
      with arrow keys.
- [ ] Keyboard: Tab order matches the screen; every shortcut shown in the
      app works; global shortcuts work with another app in front.
- [ ] Hide from stream: Notes, the floating Preview and the Stream Manager
      are absent from screen shares and from Videorc's own screen capture.
- [ ] `videorc://` links from the browser (sign-in, Stream Deck, remote)
      open the running app, or start it.
- [ ] One instance: a second start focuses the first.
- [ ] Notifications: Windows notifications for the watchdog and "update
      ready"; clicking one opens the right page.
- [ ] Files: open and save dialogs, "Show in folder", drag-and-drop of
      images and sounds, deleting to the Recycle Bin.
- [ ] The display stays awake while recording or live.
- [ ] Install, update and uninstall: the installer, SmartScreen and UAC
      prompts as today, the Start menu entry, the update from Electron, and
      an uninstall that leaves no app files.
- [ ] Performance on your PC: idle and live CPU of the app's process
      against the Electron baseline (S0.10), reported, not judged.

Videorc Camera is not on Windows today (hidden until proven), so it is not
a row.

## Sending evidence

Post one comment per run on the slice's PR (or its tracking issue, if the
PR is not open yet), in this form:

````markdown
### <slice> run <N>, <yyyy-mm-dd>

**Machine:** Windows 11 Pro 24H2 26100.2314 · Intel i5-8250U · Intel UHD 620 31.0.101.2125 · 16 GB · 1920×1080 125 % 60 Hz
**Code:** <branch> at <first 12 characters of `git rev-parse HEAD`>
**Command:** `cargo run --release -p spike-preview-windows -- --route a --resolution 4k --fps 60 --seconds 600`

| Check | Verdict | Note |
| --- | --- | --- |
| Numbers | PASS | p95 present 16.9 ms, live CPU 6.2 % |
| 1. Drag and resize | FAIL | Video lags the window by about 2 frames on fast drags |
| 2. Handles over video | PASS | |
| 3. Hidden from capture | PASS | |
| 4. Minimise and restore | BLOCKED | Window never restored: see recording at 0:42 |

<details><summary>summary.json</summary>

```json
{ "...": "paste it here" }
```

</details>

Attachments: screenshots, CPU CSV, recording (or "recording sent by the
upload link").
````

GitHub accepts attachments up to its size limit; for a larger screen
recording, ask in the PR for an upload link and say in the comment that it
was sent. Don't post links to your own cloud storage folders that show
other files or your name.

## When something fails

- A build error: post the last 50 lines of the build output and your
  `rustc --version`.
- A crash: post the last 100 lines of the spike's output (from Phase 2 on,
  the zipped `logs` folder above) and what you did just before.
- Anything that needs a code change is a code slice: say so in the comment;
  the [Windows code plan](260-gpui-rewrite-windows-code.md) says who takes
  it.
