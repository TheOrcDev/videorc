# First-run permissions acceptance (plan 203), 2026-10-27

Scope: [plan 203](../../plans/203-first-run-permissions.md), S7 smoke, docs
and acceptance, after S1 to S6. Implemented in the PR, with owner acceptance
still owed. This is automated renderer evidence, not clean-account TCC or
visual signoff. S7 changes no app source and makes no Rust build or test run.

## Host

- macOS 26.5.1 (25F80), arm64; Node v24.22.1 arm64, pnpm 11.0.9.
- Worktree `/Users/orcdev/projects/videorc-wt-203`, branch
  `plan-203-first-run-permissions`, S6 head `04243c5f`.
- Smoke evidence directory:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-first-run-PLkbUN`.
- Full step-by-step stdout: `/tmp/plan-203-s7-smoke-final.log`.

## What the smoke proves

`pnpm smoke:first-run` launches the real macOS dev app through
`launchDevApp`, explicitly setting `VIDEORC_SMOKE_SKIP_FIRST_RUN=0`. Each run
creates a unique throwaway directory containing both app data and Electron
user data. The owner profile is never used. The existing debug backend is
required and the launcher prebuild is disabled. Cleanup stops the launched
process group through the shared launcher, never a broad process scan.

CDP inspects the maintained setup attributes and localStorage. It proves:

1. Fresh install: first-run setup, four resolved permission rows, an
   in-progress record, one primary and no workspace sidebar.
2. Polished reaches moving after setup mounts. A pre-document observer
   measures mount to moving with the renderer's monotonic clock.
3. A roughly 2.1 s screencast supplies changing PNG frames, and final WebGL
   draws to the backdrop canvas obey the 31 fps ceiling. Offscreen shader
   passes and other UI animations are not counted as backdrop frames.
4. CDP reduced-motion emulation produces a still with reason
   `reduced-motion`; clearing emulation restores motion. Unexpected GPU
   stills fail with their reason rather than passing as a fallback.
5. Pressing the one primary writes done or skipped as the label promises,
   mounts the workspace, removes the canvas and releases retained WebGL
   contexts. Reload preserves completion and never shows setup.
6. A profile seeded with only the What's New key becomes existing-install
   without showing setup. An in-progress record resumes setup.
7. Settings → General → Run setup again… opens replay, preserves the raw
   first-run record and returns to Settings → General on its primary.
8. An old What's New version with an in-progress record cannot show the
   What's New dialog over setup during a continuous DOM observer watch.

The smoke never presses Allow… or changes system permissions. This host
shows Screen Recording, System audio and Microphone as not granted, and
Camera as first use. Skip for now is therefore the exercised completion;
the granted Continue branch is covered by the pure gate's test but still
needs granted-host acceptance. The smoke does not prove absence of native
OS prompts, the refused/waiting/reopen transitions, live microphone proof,
visual contrast or Windows behavior.

## Gate thresholds

| Measurement            | Bound                                  | Reason                                                                                                                    |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Setup mount to moving  | ≤ 3,000 ms                             | Plan target 2,000 ms plus 1,000 ms for dev loading and observation scheduling; measured from mount, not backend readiness |
| Motion sample          | ≥ 1,800 ms; runner requests 2,100 ms   | Gives about two seconds of evidence despite scheduling overhead                                                           |
| Changed frames         | ≥ 10; first and last PNG hashes differ | Rejects a single paint or a frozen surface without demanding lossless CDP delivery                                        |
| Final canvas draw rate | > 0 and ≤ 31 fps                       | The production cap is 30 fps; 1 fps allows sample boundaries and scheduling                                               |
| What's New watch       | ≥ 1,000 ms                             | Observe settled setup continuously, including transient overlapping dialogs                                               |
| Other readiness        | 15 s; backdrop readiness 5 s           | Bounded device/dev loading, separate from the 3 s moving gate                                                             |

`report.json` contains every observation, pass/fail result and threshold.
Screenshots and app logs remain in the temporary evidence directory and
are not committed. No S4 30 s GPU-process CPU reading or Windows cost
number is available from this S7 smoke; those measurements remain owed.

## Verification results

| Gate                                                          | Result                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Focused first-run pure gate tests                             | PASS, 40/40                                                                                                             |
| `pnpm smoke:first-run`                                        | PASS, all steps; exit 0                                                                                                 |
| `pnpm test:scripts`                                           | PASS on standalone rerun: 2,617 passed, 0 failed, 1 skipped; 2,618 tests total                                          |
| RTMP readiness focused recheck                                | PASS, 9/9, no deadline or source changes                                                                                |
| `pnpm format:check`                                           | PASS; tracked text integrity and Prettier                                                                               |
| Explicit Prettier check of all S7 files                       | PASS, including new smoke/tests and Markdown not covered by the root glob                                               |
| `pnpm lint`                                                   | PASS; 0 errors, 1 existing `captureConfig` effect dependency warning in `use-studio.tsx`                                |
| `node scripts/check-em-dashes.mjs`                            | PASS, 890 files                                                                                                         |
| `git diff --check`                                            | PASS                                                                                                                    |
| `pnpm smoke:local-gates`, recording/device smokes, Rust gates | Not run in this S7 scope: no app-source changes, existing debug backend required, Rust builds/tests explicitly excluded |

The passing standalone script-suite rerun completed in 13.12 s, exit 0.
The initial script-suite run overlapped the app smoke, formatting and lint.
The existing `RTMP readiness waits for an owned listener without a fixed
startup sleep` test missed its 100 ms deadline (123.11 ms). Its focused
recheck passed in 2.44 ms; nothing in that test or its deadline was changed.

Smoke step transcript, with observations condensed from the complete raw
stdout and `report.json`:

```text
PASS fresh (untouched profile): first-run, four rows, in-progress, no sidebar, Skip for now
PASS fresh (measured reload): first-run, four rows, in-progress, no sidebar, Skip for now
PASS moving: Polished, 52.4 ms from setup mount
PASS motion: 63 frames, different PNG hashes, 63 final canvas draws / 2102.8 ms = 29.96 fps
PASS reduced-motion: still, reason reduced-motion, no canvas
PASS moving (emulation cleared): moving, no still reason
PASS finish: skipped, workspace visible, no canvas, retained contexts lost
PASS reload: no setup, finished record unchanged
PASS existing-install: only What's New seeded, existing-install record, no setup
PASS resume: in-progress reopened first-run setup with four rows
PASS replay-open: replay mode, record byte-for-byte unchanged
PASS replay-return: Settings General, record byte-for-byte unchanged, no canvas
PASS whats-new: old 0.0.1 seed plus in-progress, no dialog over setup during 1100 ms watch
PASS first-run smoke: all steps passed
```

Two development attempts preceded the passing run. The first probe counted
an offscreen shader pass as well as the final canvas draw, incorrectly
reporting 60.59 fps; the probe was corrected to count only the default
framebuffer, retaining the 31 fps gate. The next attempt passed through
replay entry, then the renderer reloaded before the return click. Its log
also records an external source HMR update, and the failure state shows a
new document id. The unchanged gate passed on the next run. No app bug was
worked around or app source edited by S7.

A concurrent session briefly changed
`apps/desktop/src/renderer/src/components/sources/source-permission-alerts.test.ts`
while S7 ran. S7 did not edit or revert it. No app-source difference
remained in the worktree at the final S7 file review.

## OWNER-OWED acceptance

- [ ] **S0, clean macOS user account, packaged app and dev app.** Record
      macOS version, prompt order and exact names in System Settings. Does a
      fresh install prompt cold at launch? Verify zero native prompts
      before a click, including Clips, the warm microphone and preview.
- [ ] **Screen request from main's identity.** Allow… raises exactly one
      prompt and lists Videorc (Electron for dev), rather than a helper the
      person must add manually. Stop and escalate if the helper has its own
      required entry.
- [ ] **System audio rides the screen grant.** Both rows turn green
      together and real System audio samples arrive. Check a final artifact,
      not just a green chip.
- [ ] **Reopen Videorc after a screen grant.** Record Quit & Reopen versus
      Later, live backend restart behavior, the Reopen action, resumed
      in-progress setup and a grant made after more than 90 s away.
- [ ] **Other permission transitions.** Allow camera/microphone, speak to
      see the proof bar, deny each permission, open System Settings, grant
      there and return. Skip with gaps and verify Sources offers the
      in-place action for a never-asked screen. A finished install never
      sees automatic setup again; an existing install skips it on update.
- [ ] **By-eye in light AND dark.** Card contrast and scrolling, title band,
      traffic-light gutter, reduced transparency, high contrast, focus,
      keyboard and screen-reader announcements. Replay from Settings in
      both themes. D8's look decision is settled, but full visual acceptance
      is still owed.
- [ ] **Windows tester pass.** Four rows, desktop-apps switch copy, moving
      backdrop or a poster with an explicit reason, replay and completion.
      Record fps and GPU-process CPU over 30 s on the tester's machine.
- [ ] **S4 cost measurement on the owner's Mac.** Record drawn fps and
      GPU-process CPU over 30 s with setup open. S7's two-second sample is
      not this cost measurement.
- [ ] **Long refused-row copy.** Review the full line and pane/app naming in
      the real card at compact window sizes, in both themes.
- [ ] **Review D2, D3 and D5 to D7, shipped as recommended.** Every fresh
      install sees setup once; nothing blocks leaving; one primary changes
      Continue / Skip for now. Screen Recording and Microphone are needed,
      Camera optional. Settings → General and ⌘K say Run setup again…,
      entry is locked during recording/livestream, and replay preserves the
      record. Microphone proof and camera name are the chosen proof. The
      title is Welcome to Videorc and the term is first-run setup.
- [x] **D8 owner decision, by-eye 2026-10-27.** Polished at Normal, dimmed
      30% under dark. Mercury at Calm did not read as live.

## Execution details

The [plan's execution notes](../../plans/203-first-run-permissions.md#execution-notes)
list S1 to S6 commits and deviations: the 405,000-byte eager gzip budget,
`app:workspace-shown` Preview restoration, Clips held during setup, the
StrictMode lost-context fix, Setup below Stream Manager for column balance,
and remote-control intents remaining active during replay.
