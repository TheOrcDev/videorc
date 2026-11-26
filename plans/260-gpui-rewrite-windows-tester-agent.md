# Plan 260, Windows: instructions for a tester agent

You are an AI coding agent (Claude Code, Codex or similar) on a real
Windows 11 PC, testing Videorc's new desktop app, which is built on GPUI.
A person (the PC's owner, a Videorc contributor) is with you for the steps
an agent can't do. This file is your whole brief: follow it top to bottom.

It goes with [plan 260](260-gpui-rewrite.md) and the human testing guide,
[260-gpui-rewrite-windows-testing.md](260-gpui-rewrite-windows-testing.md),
which has the exact expected results for every Phase 0 check. When this
file says "the testing guide, S0.x", open that section and follow it to
the letter.

## What you are for

Videorc has no Windows PC of its own. The app is being rewritten from
Electron to GPUI on macOS, Linux and Windows at once. macOS and Linux are
proven by the maintainers; **Windows is proven only by runs on real PCs
like this one.** Your job is to produce those runs: a verdict per check,
with evidence a maintainer can trust without being there.

You are a tester, not a fixer. Don't change product code, don't open pull
requests with fixes, and don't work around a failure to get a pass. A
clear `FAIL` with its log is the most useful thing you can send.

## Rules (all of them, always)

1. **Verdicts:** every check gets exactly one: `PASS`, `FAIL` or `BLOCKED`.
   - `PASS` only when what happened matches **Expected** completely.
   - `FAIL` when anything differs, however small. Say what, and attach the
     evidence. Maintainers decide what matters.
   - `BLOCKED` when you could not run it; say why. It is never a soft pass.
   - Never mark a check you didn't run, and never reuse another run's
     result.
2. **No fakes.** No virtual camera, virtual microphone, virtual display or
   VM to make a step pass. If the device isn't there, it's `BLOCKED`.
3. **Secrets and privacy.** Never print, log, screenshot or post
   passwords, tokens, stream keys, email addresses, real viewers' chat,
   serial numbers, MAC addresses, or paths with the person's user name.
   Before you attach a log, replace the user-name part of every path with
   `<user>`. Don't read the person's other files, browser data or
   credentials.
4. **Accounts.** Use the throwaway test profile below. Don't sign in to
   Videorc, YouTube, Twitch, X or Kick unless a maintainer has given a
   test account for that step. Never go live on a real channel.
5. **Repository.** Read-only on `main` and `spikes/gpui`: `git pull` and
   builds only. Never commit, push, merge, rebase or force anything. Never
   commit evidence. No `git stash`, `git clean` or `git reset --hard` in a
   checkout that has the person's own changes; if `git status` isn't
   clean, ask the person before you switch branches.
6. **The machine.** Don't change system settings beyond what a step names
   (display scale, theme, keyboard languages), and put each one back
   afterwards. Don't run anything as administrator unless the step says
   so, and then ask the person first. Stop only processes you started,
   by their PID; never kill by name or pattern.
7. **Power and quiet.** For timed checks the PC is on AC power, other
   heavy programs are closed, and the window under test is not covered.
   Ask the person to keep it that way while a timed run goes.
8. **Ask the person** for anything only a human can do, and wait for the
   answer. Those steps are marked 👤 below. Write exactly what to do and
   what to look or listen for, and record their answer word for word in
   the notes.
9. **Stop and report** if a build or test would need more than 12 GB of
   memory, the disk has less than 40 GB free, or the PC becomes
   unresponsive. Report it as `BLOCKED` with the numbers.

## 1. Your machine

Collect this once, with PowerShell (`Get-ComputerInfo`, `Get-CimInstance
Win32_VideoController`, `Get-CimInstance Win32_Processor`,
`[Environment]::ProcessorCount`, Settings → System → Display), and put it
at the top of every report:

| Field | Example |
| --- | --- |
| Windows edition and build | Windows 11 Pro 24H2, build 26100.2314 |
| CPU, logical processors | Intel Core i5-8250U, 8 |
| GPU(s) and driver version | Intel UHD 620, 31.0.101.2125 |
| RAM | 16 GB |
| Display(s): resolution, scale, refresh | 1920×1080, 125 %, 60 Hz |
| Camera and microphone (kind only) | USB webcam, USB microphone |
| Free disk on the repo's drive | 210 GB |

Never record the machine's make, serial or the user name.

## 2. One-time setup

Follow the testing guide's "One-time setup" (Git, Visual Studio 2022 Build
Tools with "Desktop development with C++" and the Windows 11 SDK, Rust
`stable-x86_64-pc-windows-msvc`, Node.js 24, then `corepack enable`).
Installing those needs the person: 👤 ask them to run the installers and
accept the UAC prompts.

Then, in PowerShell:

```powershell
git clone https://github.com/TheOrcDev/videorc.git
cd videorc
corepack install
pnpm install
pnpm ffmpeg:fetch:windows
rustc --version; cargo --version; node --version; pnpm --version
Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter fxc.exe | Select-Object -First 1 FullName
```

**Expected:** every command exits 0, and the last one prints a path ending
in `x64\fxc.exe`. If GPUI's build later can't find `fxc.exe`, set
`$env:GPUI_FXC_PATH` to that path.

Keep builds light: `$env:CARGO_BUILD_JOBS = '2'` on a PC with 16 GB or
less, `'4'` with 32 GB or more. The first GPUI build takes 15 to 45
minutes.

## 3. The test profile and the evidence folder

Every PowerShell window you start Videorc or a smoke from sets:

```powershell
$test = "$env:TEMP\videorc-gpui-test"
$env:VIDEORC_APP_DATA_DIR = "$test\app-data"
$env:VIDEORC_USER_DATA_DIR = "$test\user-data"
```

Delete `$test` only when a step says "fresh profile".

Evidence lives outside the repository:

```text
%USERPROFILE%\videorc-evidence\<check>\<yyyy-mm-dd>-run<N>\
  report.md        the verdict table (section 9's format)
  summary.json     when a spike prints one
  logs\            command output (Tee-Object), app logs
  screenshots\     PNG, <check>-<what>.png, the window only
  notes.md         what you saw, and the person's answers word for word
```

Save every command's output with `2>&1 | Tee-Object <file>`.

**Screenshots: the window only, never the whole screen.** The person's
other windows must never be in evidence. Use a window capture: 👤 ask the
person for Alt+PrtScn and paste into Paint, or capture by window handle
from PowerShell if you have a tool for it. Check every image before you
keep it; delete any that shows anything but the app.

## 4. What state the Windows app is in (read before testing)

So you know what "expected" means today:

- **The GPUI app compiles on Windows** (CI builds it on `main`), but no
  one has run it on a real Windows PC yet. You may be the first.
- **The Preview has no Windows path yet.** The video preview inside the
  app waits for plan 260 decision D12 (S2.3b), which waits for the S0.2c
  numbers. Expected today: the Preview area shows its schematic or
  "no preview on this platform yet", and the app's log has
  `[preview] no preview element on this platform yet (S2.3b on Windows)`.
  That is **not** a FAIL. Everything around the Preview (recording,
  sources, meters, the other screens) should still work.
- **The look is already approved on macOS and Linux** against the
  Electron app. On Windows, compare against today's **Videorc Windows
  Alpha** (Electron), installed side by side.

## 5. The order of work

Do these in order. Each numbered block is one report. If a block is
`BLOCKED` at its first step, report it and move to the next block.

### A. The GPUI app starts on Windows (highest value)

```powershell
cd videorc
git switch main; git pull; pnpm install
$env:CARGO_BUILD_JOBS = '2'
cargo build -p videorc-backend -p videorc-app 2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\A\build.txt"
.\target\debug\Videorc.exe 2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\A\run.txt"
```

(Run the `$test` lines from section 3 first, with a fresh profile.)

| # | Check | Expected |
| --- | --- | --- |
| A1 | Build | Exits 0. Report the minutes and `git rev-parse HEAD` |
| A2 | First window | The main window opens within 5 seconds with the sidebar, title bar and status bar; first run shows its setup steps |
| A3 | Backend | Within 10 seconds the status bar shows the backend as ready; no error toast |
| A4 | Pages | Every sidebar page opens (Studio, Sources, Scene, Captions, Output, Destinations, Guests, Avatar, Sidekick, Library, Settings), and Health opens from Ctrl+K, with no crash and no blank page |
| A5 | Title bar | Windows' minimise, maximise and close work; hovering maximise shows snap layouts; double-clicking the header maximises |
| A6 | Theme | Settings → General → Theme: dark and light both draw correctly; "System" follows Windows' own setting live |
| A7 | Scale | 👤 Set display scale to 100 %, then your highest (150 % or 200 %): text sharp, nothing cut off or overlapping. Then back |
| A8 | Quit | Closing the window quits the app and its `videorc-backend.exe` within 5 seconds (check Task Manager by PID) |

**Send:** the verdict table, a screenshot of each page in dark (light for
Studio and Settings too), `build.txt` (last 50 lines), `run.txt`, and the
app's logs from `$env:VIDEORC_USER_DATA_DIR\logs\` (paths cleaned).

### B. The smokes on the GPUI app

The smokes start the app themselves, drive it through its accessibility
tree (the tree Narrator reads) and print a verdict. Run each once, one at
a time:

```powershell
$env:VIDEORC_APP = 'gpui'
pnpm smoke:first-run          2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\first-run.txt"
pnpm smoke:recording-matrix   2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\recording-matrix.txt"
pnpm smoke:record-latency     2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\record-latency.txt"
pnpm smoke:soundboard         2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\soundboard.txt"
pnpm smoke:captions-live      2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\captions-live.txt"
pnpm smoke:app-quit-recording 2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\app-quit-recording.txt"
pnpm smoke:output-stall       2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\output-stall.txt"
```

**Expected:** each ends with its own PASS line and exits 0. A smoke that
answers "not supported on this platform" by name is `BLOCKED` (quote the
line), not `FAIL`. Don't rerun a failing smoke more than once; if the
second run differs from the first, report both.

Also run the Electron app's Windows gate once, as the baseline (no
`VIDEORC_APP`):

```powershell
Remove-Item Env:VIDEORC_APP -ErrorAction SilentlyContinue
pnpm smoke:local-gates:windows 2>&1 | Tee-Object "$env:USERPROFILE\videorc-evidence\B\electron-local-gates.txt"
```

**Send:** per smoke, the verdict and the last 40 lines; the gate's report.

### C. A real recording on the GPUI app

👤 This needs the person: a camera and microphone plugged in, and them
nearby to talk for 10 seconds.

1. Fresh profile. Start `Videorc.exe` (block A). Go through first run with
   the real camera and microphone.
2. On Studio, press Record. 👤 Ask the person to speak and wave at the
   camera for 20 seconds. Press Stop.
3. Open Library: the recording is there. Play it.

| # | Check | Expected |
| --- | --- | --- |
| C1 | Devices | The camera and microphone appear by their names in Sources; the mic meter moves when the person speaks |
| C2 | Record and Stop | Both respond within 1 second; the status bar shows recording time |
| C3 | The file | `ffprobe` (in `vendor\ffmpeg\windows-x64`) shows video and audio streams, the length within 1 second of what was recorded |
| C4 | Audio and video in sync | 👤 The person watches the playback: lips match the voice |
| C5 | Library | The recording is listed with a thumbnail and plays |

**Send:** the verdict table, `ffprobe -hide_banner <file>` output, a
screenshot of Studio while recording and of Library. Don't attach the
recording itself (it has the person's face and voice) unless they say
yes.

### D. The Phase 0 checks still owed on Windows

On the `spikes/gpui` branch, as the testing guide describes:

```powershell
git switch spikes/gpui; git pull
cd spikes\gpui
```

Run, each as its own report, following the testing guide's section word
for word:

- **S0.2b** (on `main`, not the spikes branch): the preview hand-over
  tests. `cargo test -p videorc-backend --bin videorc-backend
  preview_handover -j 2 -- --test-threads=1`. This build is heavy: run it
  alone, nothing else compiling.
- **S0.4** `spike-chrome`: the look in dark, light and a contrast theme.
- **S0.5** `spike-text`: 👤 Japanese and Chinese input and emoji need the
  person to type. You run the spike and the 10,000-row scroll numbers.
- **S0.6** `spike-a11y`: you run `--driver-check`. 👤 Narrator needs the
  person to listen and tell you what it says for each control.
- **S0.7** `spike-desktop`: the nine checks; 👤 the hotkey, the deep link
  from Win+R, the notification and drag-and-drop need the person's hands
  or eyes; `powercfg /requests` needs an admin PowerShell (👤 ask).
- **S0.8** `spike-room`: two builds and their sizes.
- **S0.9**: clean build time and target size from S0.4's build; five
  start-ups of `spike-text`, `startup_to_first_paint_ms` from each.

**S0.2c** (the four preview routes) needs `spike-preview-windows`, which
is code from the Windows code plan (WC-0.2 to WC-0.5). If
`spikes\gpui\spike-preview-windows` doesn't exist, report S0.2c as
`BLOCKED: spike not built yet` and don't write it.

### E. Side by side with the Electron app (parity by eye)

👤 Ask the person to install the newest **Videorc Windows Alpha** from the
website (not signed in). For each page and window in the testing guide's
"Windows parity checklist" and in A4's list:

1. Same page in both apps, same size window, same theme.
2. A window screenshot of each, in dark and light.
3. One verdict per page: `PASS` when the GPUI page matches Electron's
   layout, text, controls and colours; else `FAIL` with what differs
   ("the Record button is 4 px lower", "the mic name is cut off").

Then the Windows-only rows of the checklist (scale, IME, Narrator,
keyboard Tab order, Hide from stream, `videorc://` links, one instance,
notifications, files, display stays awake while recording). Mark each row;
the ones you can't do alone are 👤.

### F. Cost on this PC (reported, not judged)

The Studio page open, idle, not recording, for 5 minutes, first in the
Electron Alpha, then in the GPUI app, the window uncovered, on AC power.
Use the testing guide's `Measure-VideorcCpu` with
`-Names 'Videorc*','videorc-backend' -Seconds 300`. Then once more each
while recording (block C's setup).

**Send:** the four CSVs, the average and the 95th percentile per process,
and the working set of each process at the end (`Get-Process -Id <pid> |
Select-Object Name,WorkingSet64`).

## 6. When something fails

- **Build error:** the last 50 lines of the output, `rustc --version`, and
  whether `fxc.exe` was found. Don't try a second toolchain.
- **Crash or hang:** the last 100 lines of the run's output, the app's
  `logs` folder (zipped, paths cleaned), what you did just before, and
  whether it happens again on a second try. For a hang, a screenshot of
  the window and Task Manager's CPU and memory for its PIDs.
- **A smoke fails:** its last 40 lines and the app logs; no fixes.
- **Something looks wrong but you're not sure:** report it as `FAIL` with
  a screenshot and your doubt in the note.

## 7. What you never do

- Change product code, CI files, release, signing or update workflows.
- Commit, push or open pull requests (reports go as comments, below).
- Go live, post, or sign in to anything real.
- Turn on a virtual device, a VM or a fake to make a check pass.
- Kill processes you didn't start, or by name.
- Capture the whole screen.

## 8. How long it takes

Roughly, on a typical laptop: setup 1 to 2 hours (mostly builds); A 1
hour; B 1 to 2 hours; C 30 minutes; D 3 to 5 hours; E 2 hours; F 30
minutes. Tell the person before each 👤 block how long you need them.

## 9. The report

One report per block, saved as `report.md` in its run folder, and posted
by the person (or by you, if they've set up `gh` and say so) as a comment
on the issue or pull request the maintainers name. If none was named,
hand `report.md` and the evidence folder to the person.

````markdown
### <block or slice> run <N>, <yyyy-mm-dd>

**Machine:** Windows 11 Pro 24H2 26100.2314 · Intel i5-8250U (8) · Intel UHD 620 31.0.101.2125 · 16 GB · 1920×1080 125 % 60 Hz
**Code:** main at <first 12 characters of `git rev-parse HEAD`>
**Run by:** <agent name and model>, with <the person's GitHub handle> for 👤 steps
**Commands:** `cargo build -p videorc-backend -p videorc-app`, `.\target\debug\Videorc.exe`

| Check | Verdict | Note |
| --- | --- | --- |
| A1 Build | PASS | 31 min, target 9.8 GB |
| A2 First window | PASS | 2.1 s |
| A3 Backend | FAIL | status bar says "Backend starting…" for 40 s, then an error toast: see run.txt line 212 |
| A7 Scale | BLOCKED | the person was away |

**Summary:** 6 PASS, 1 FAIL, 1 BLOCKED.

Attachments: screenshots, logs (paths cleaned).
````

Write notes in plain words. Say what you saw, not what you think the
cause is, unless the log says it outright.
