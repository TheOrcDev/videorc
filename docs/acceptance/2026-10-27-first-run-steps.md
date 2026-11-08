# First-run steps acceptance (plan 207), 2026-10-27

Scope: [plan 207](../../plans/207-first-run-setup-steps.md), S8 smoke, docs
and acceptance, after S1 to S7. Built in the PR, unmerged. Automated
renderer/backend evidence is recorded here; the owner checklist below is
still owed. S8 changes no app source and adds no DOM attributes.

## Host and evidence

- macOS 26.5.1 (25F80), arm64; Node v24.22.1 arm64; pnpm 11.0.9.
- Worktree `/Users/orcdev/projects/videorc-wt-207`, branch
  `plan-207-first-run-steps`, committed S1 to S7 head `9a13f3de`.
- Final smoke evidence: `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-first-run-WxKM7Q`.
- Full smoke stdout: `/tmp/plan-207-s8-smoke.log`; script-suite stdout:
  `/tmp/plan-207-s8-script-tests.log`.
- Observed dev Electron grants: Camera `not-determined`, Microphone
  `denied`, Screen Recording `denied`. The smoke reads grants and never
  presses Allow or opens System Settings.
- YouTube, Twitch and Kick say signing in is unavailable in this build
  (no client ids). X offers Sign in…. No account flow is started.

`pnpm smoke:first-run` uses the real dev app through `launchDevApp`, with
three fresh, independent app/user/backend-data profiles under one unique
temporary output directory. The owner profile is never used. The debug
backend must already exist; the launcher's backend prebuild is disabled.
`ELECTRON_RUN_AS_NODE` is removed before spawning Electron. The shared
launcher stops only its owned process tree. Logs, screenshots, local
credentials and profiles remain outside the committed tree.

## Smoke steps and results

PASS, exit 0: 39 gate evaluations across three actual isolated profiles.
Every gate passed; conditional paths report explicit skips below.

| Check                                 | Observed result                                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh install and plan 203 frame      | Four resolved permission rows; open first-run setup; one primary; in-progress record; no workspace before setup                                                                                |
| Initial motion                        | Polished Liquid Chrome moves within the 3 s dev allowance; screencast PNGs change and final canvas draws stay at or below 31 fps                                                               |
| Reduced motion                        | Still with `reduced-motion`; no backdrop canvas; clearing emulation restores motion                                                                                                            |
| Permissions → goal                    | Primary advances to What are you making? at 2/5; v2 record saves `in-progress` at `goal`; three choices and no footer primary                                                                  |
| Recordings                            | Goal `record`, Your look at 3/4; Where you stream is dropped                                                                                                                                   |
| Your look                             | All layouts disabled with actual grant reasons; layout click explicitly skipped. Silk is selected; registry and backend committed scene agree with captureConfig's layout                      |
| Two players                           | 30 s final-framebuffer draw sample; both remain moving and obey the cap; numbers below                                                                                                         |
| Sound check                           | Microphone and System audio rows present; missing-microphone alert observed. Gain key press and real voice verdict explicitly skipped because Microphone is denied                             |
| Same-profile reload                   | Resumes at Sound check with layout, audio and background preserved. Reload can normalize missing source-off flags to false                                                                     |
| Open Studio                           | `done`, workspace visible, same committed layout and Silk background; no Clips failure toast during a continuous 10 s observer watch and no backend `Session start refused`                    |
| Finished reload                       | Raw finished record preserved; no setup flash                                                                                                                                                  |
| Settings replay                       | Every step, including destinations using Both in memory; no look/audio/account changes. Raw first-run record and captureConfig byte-identical before/after; Done returns to Settings → General |
| Existing-install migration            | What's New marker alone becomes `existing-install` without setup                                                                                                                               |
| Legacy resume and What's New ordering | v1 in-progress resumes Permissions; old What's New version stays held behind setup; Skip setup still leaves immediately                                                                        |
| Livestreams profile, light theme      | Every step, four destination rows with honest availability; Open Livestream saves `done` and lands on Livestream → Setup                                                                       |
| Third profile, skip from look         | Both and Silk selected; Skip setup writes `skipped` at `look`; raw captureConfig and background registry kept                                                                                  |
| Theme evidence                        | Dark and light PNGs for Permissions, What are you making?, Your look, Sound check and Where you stream, saved under the smoke output directory                                                 |
| Camera/screen hold                    | Open-to-close log scans have zero source admissions; status snapshots show zero captured frames and no active source on this host                                                              |

`report.json` records each gate, raw observations, thresholds and explicit
`skipped` reasons. The no-grant paths are tested rather than reported as
successful layout clicks, microphone changes or sign-ins. On a granted
host the runner chooses an available layout and sends a real keyboard
arrow to Gain, then verifies `microphoneGainDb` changes. Replay may retain
an already-running workspace source; its identity must stay unchanged and
new source admissions still fail.

Replay's byte baseline is taken after backend connection, scene readiness,
no pending source/visual transaction and 750 ms of unchanged storage. This
keeps reload reconciliation outside the replay interval without weakening
the byte-identity assertion.

## Measured cost and source-start witnesses

The final smoke measured:

| Measurement                  | Result                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Initial setup mount → moving | 18.0 ms                                                                                         |
| Initial screencast           | 64 frames over 2,107.7 ms; first/last PNG hashes differ                                         |
| Initial backdrop draws       | 63 draws, 29.89 fps                                                                             |
| Two-player sample            | 30,051.9 ms                                                                                     |
| Backdrop                     | 900 draws, 29.9482 fps; moving throughout                                                       |
| Your look picture (Silk)     | 900 draws, 29.9482 fps; moving throughout                                                       |
| GPU process CPU              | 11.3110% of one core over the two-player sample                                                 |
| Post-workspace Clips watch   | 10,109 ms; zero Clips failure toasts and refused starts                                         |
| Setup source-start scans     | Six complete open-to-close intervals; zero matching log lines                                   |
| Screenshots                  | Five dark and five light step PNGs, plus reduced motion, replay, Studio and Livestream evidence |

The no-grant host retained `screen-camera` because every layout was
disabled; the smoke did not pretend to choose Camera only. The committed
layout stayed `screen-camera` and the committed background stayed Silk
when Studio opened.

Draw counts intercept `WebGL2RenderingContext.drawArrays` only when the
default framebuffer is bound, and classify the canvas by its backdrop or
picture ancestor. Offscreen shader passes are excluded. The limit is 31
fps per player (production cap 30 plus sampling tolerance). GPU CPU is the
Chromium GPU process's `cpuTime` delta over that same interval, expressed
as percent of one core; it is not a GPU utilization percentage. Windows
cost remains owed.

The maintained source-start patterns are:

```text
\[capture-generation\] source=(?:camera|screen|window)\b[^\r\n]* config=
screen capture startup phase
\[videorc-capture-sizing\]
```

`preview_camera.rs::log_camera_generation` and
`preview_screen.rs::log_screen_generation` emit the first pattern at
source admission before queuing native capture, including normal starts,
recovery starts and reuse. Stop/join-only diagnostics have no `config=`
and are excluded. The screen startup phase and native capture sizing
messages are additional witnesses. Unit tests pin all three source kinds,
normal/recovery/reuse and the stop exclusion.

The runner enables backend info logging, strips ANSI color and uses the
backend's emission timestamp (including sub-millisecond precision). A
renderer binding timestamps actual removal of the setup root, after its
leaving fade. Each scan covers setup opening through that close; reloads
while setup is open remain inside the interval. Backend preview status is
also sampled on entry and immediately before leaving. On this host the
idle statuses are `device-missing` and `source-missing`, with zero frames.
The 10 s post-workspace observer also retains transient Sonner toast text.

## Verification

| Gate                                                                                   | Result                                                                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `node --test scripts/lib/first-run-smoke-gate.test.mjs`                                | PASS, 101/101; 0 failed, 0 skipped                                                             |
| `pnpm smoke:first-run`                                                                 | PASS, 39 gate evaluations across three profiles; exit 0                                        |
| `pnpm test:scripts`                                                                    | PASS, 2,678 passed; 0 failed; 1 existing skipped test; 2,679 total (9.63 s)                    |
| `pnpm format:check`                                                                    | PASS; tracked text integrity and all root Prettier globs                                       |
| `node scripts/check-text-files.mjs`                                                    | PASS, 3,047 tracked text files                                                                 |
| Explicit Prettier check of every S8 file                                               | PASS, all ten S8 files including new Markdown                                                  |
| `git diff --check`                                                                     | PASS                                                                                           |
| `pnpm smoke:replay-buffer`, `pnpm smoke:scene-presets`, `pnpm probe:preview-lifecycle` | Not run by S8; orchestrator owns these end-of-plan gates                                       |
| `pnpm smoke:local-gates`                                                               | Not run by S8, as instructed; orchestrator runs the bundle once at the end                     |
| Recording/device, Rust, desktop unit/build, typecheck/lint gates                       | Not rerun by S8: no app-source changes. S1 to S7 and the orchestrator own their relevant gates |

The script suite's one existing skip is
`the prompt copy matches videorc-web but for what it owes`: the external
`VIDEORC_WEB_DIR` checkout is not configured. No first-run gate test is
skipped (101 passed).

The acceptance claim is limited to these recorded runs. No real OAuth
sign-in, cold TCC prompt, live voice verdict, camera preview or Windows
acceptance is claimed.

## Owner checklist still owed

- [ ] Both themes, every step; the step-to-step motion; Your look at `xl`.
      Both-theme screenshots exist; by-eye approval remains owed.
- [ ] The picture with three live backgrounds, horizontal and vertical.
      Smoke covers Silk and Side Rays horizontally; three-background and
      vertical visual acceptance remain owed.
- [ ] Sound check with your own voice: the verdict and Set level for me.
      Blocked here by the dev Electron microphone grant.
- [ ] A real sign-in to YouTube (consent dialog) and one of Twitch or Kick
      on a release-like build. Then Go Live… is enabled. Blocked here by
      missing dev client ids; the smoke intentionally starts no browser flow.
- [ ] Skip Screen Recording on a clean account: Your look preselects Camera
      only, and no Clips toast appears. This host proves the no-grants/no-toast
      case; the camera-granted, screen-denied case remains owed.
- [ ] Windows tester: every step, the cost numbers, and Sound check through
      the analyser.

A live camera picture inside setup is outside plan 207's scope. The
committed-scene picture names devices; real camera motion is checked in
the Studio after setup on a granted host.
