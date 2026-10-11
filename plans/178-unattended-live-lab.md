# Plan 178: Unattended live lab. A dedicated Mac goes live on @VideorcApp by itself, on a schedule and on demand, and reports what breaks

> **Executor instructions**: Follow this plan slice by slice. Run every
> verification command and confirm the expected result before moving to the
> next slice. If anything in "STOP conditions" happens, stop and report. Do
> not improvise. When done, update this plan's entry in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat c0e87e53..HEAD -- apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/components/go-live-dialog.tsx apps/desktop/src/renderer/src/lib/go-live-flow.ts apps/desktop/src/renderer/src/lib/remote-surface.ts crates/videorc-backend/src/oauth.rs crates/videorc-backend/src/remote_control.rs crates/videorc-backend/src/diagnostics.rs apps/desktop/src/main/backend-log-file.ts scripts/lib/app-launcher.mjs scripts/lib/remote-control-client.mjs scripts/sign-macos-local-app.mjs .agents/skills/videorc-live-lab/SKILL.md`
> If `VIDEORC_REMOTE_DEBUG_PORT`, `decideGoLiveStart`, the runtime
> `VIDEORC_YOUTUBE_CLIENT_ID` / `_SECRET` override, or the Go Live dialog's
> privacy field changed, re-check "What exists today" first. A mismatch is a
> STOP condition.

## Status

- **Priority**: P1. Dozens of merged plans end with "live acceptance owed",
  and the "app says On air, YouTube has nothing" class (plan 161) is only
  caught live. The owner wants Claude to go live and test without anyone at
  the machine.
- **Effort**: XL in total, but Phase A alone (about 3 agent days) puts an
  unattended stream on air. 16 slices in 3 phases.
- **Risk**: MEDIUM. Real streams on a real channel with nobody watching, and
  secrets on a machine nobody sits at. Product changes are small, additive
  and off by default (journal, log retention, crash dumps, test ids). The
  safety comes from a policy file the agent cannot edit (U4), not from
  agent judgement.
- **Supersedes**: plan 166 (unattended soak) and the attended-only parts of
  plan 176. Plan 176's harness design (L0-L5), test matrix and quota budget
  carry over unchanged unless a slice below says otherwise. Plan 166's S2
  (a product setting for remote Go Live without the dialog) is **dropped**:
  CDP clicks the real dialog in any build (see "What exists today").
- **Depends on**: the owner's machine visit (U3, about 30 min at the lab
  Mac) and decisions D1-D10.
- **Category**: test infrastructure + small product additions
- **Planned at**: commit `c0e87e53` (origin/main), 2026-10-12
- **Executed**: U0 built on branch `feat/live-lab-l0` (`5353ca22`, not yet
  merged); real consent and an all-PASS doctor are owed on the lab machine.
- **Route**: Orchestrator, fit 10, model lane `fable-5` (multi-system,
  public output, secrets, unattended). Per-slice lanes in "Model lane note".

## Goal

A dedicated Mac (the lab machine) runs Videorc with nobody at it and:

1. **On a schedule** goes live on @VideorcApp and runs soak scenarios
   (marathon, churn, idle, update) from plan 166.
2. **On demand** runs any plan 176 suite (first light, OAuth Go Live, chat,
   on-stream features, resilience, long/vertical/scheduled) against the
   public release or a signed candidate of any ref. Claude starts these from
   any session without asking the owner, inside the limits of the owner's
   policy file.
3. Checks both sides: what the app thinks happened (journal, health events,
   census) and what YouTube received (observer API reads, clips of the
   public output analysed for freezes, audio gaps and A/V sync, frame checks
   for on-stream features).
4. Writes a report per run, opens or updates one GitHub issue per failure
   signature, pings Discord on P0, and never leaves anything live.

The owner only does a one-time machine visit, writes the policy, and reads
reports. The owner can stop everything remotely within 60 s.

## What exists today (verified at `c0e87e53`)

The building block tables in plan 166 ("What exists today") and plan 176
("What exists today") are still accurate. The facts this plan leans on:

| Fact                                                                     | Where                                                                     | Consequence                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `VIDEORC_REMOTE_DEBUG_PORT` appends `remote-debugging-port` in any build | `apps/desktop/src/main/index.ts:971-974`                                  | The harness clicks the real Go Live dialog through CDP, packaged builds included. **No product change to go live unattended.**   |
| Remote `streamStart` always opens the confirmation dialog                | `apps/desktop/src/renderer/src/lib/go-live-flow.ts` (`decideGoLiveStart`) | Remote control drives features, not Go Live. Unchanged on purpose.                                                               |
| Go Live dialog has 9 `data-testid`s                                      | `apps/desktop/src/renderer/src/components/go-live-dialog.tsx`             | U6 adds the missing ones (privacy, destinations, confirm, outcome).                                                              |
| Runtime YouTube OAuth client override                                    | `crates/videorc-backend/src/oauth.rs:2944-2947`                           | Lab Go Lives use the lab Google project; shared quota stays at zero.                                                             |
| Local macOS builds are signed with the Developer ID                      | `scripts/sign-macos-local-app.mjs:8-9` (`pnpm sign:desktop:local`)        | A Developer ID signature keeps a stable designated requirement, so TCC grants survive new builds. Ad-hoc builds would lose them. |
| Release workflow has the signing secrets                                 | `.github/workflows/release-macos.yml:90-100` (`CSC_LINK`, ...)            | U5 can sign lab candidates in CI, so the signing key never sits on the lab machine.                                              |
| Self-hosted real-hardware runner pattern                                 | `.github/workflows/performance-macos.yml:108,137`                         | Proves a logged-in, TCC-granted Mac setup works.                                                                                 |
| Manual-RTMP destinations make zero YouTube Data API calls                | plan 166 table (`use-studio.tsx`, prepare only for `authMode==='oauth'`)  | Scheduled soaks cost no quota at all.                                                                                            |

**Gaps** (closed below): no on-disk time series and logs that overwrite
themselves (U1, U2); no machine runbook (U3); nothing stops an agent from
widening its own limits (U4); no way to get a signed candidate onto the lab
machine (U5); no harness (U6-U9); no remote entry point or schedule (U10,
U11); by-eye checks need a human (U9 frame checks, U12 triage).

## How it works

```
 Owner's Mac / any Claude session            Lab Mac (dedicated user, no personal data, auto-login)
 ┌─────────────────────────────┐             ┌─────────────────────────────────────────────────────────────┐
 │ "test PR #812 live"         │   SSH       │ /Library/Application Support/VideorcLab/policy.json         │
 │  → gh workflow run          │  (Tailscale)│   owner-owned, read-only to the lab user (U4)              │
 │    lab-candidate-macos (U5) │────────────►│                                                             │
 │  → pnpm live:remote ...(U10)│             │ launchd (U11) ──► pnpm live:run --scenario <name>           │
 │  ◄─ progress + report       │             │   checks policy, lock, kill switch, quota, then:            │
 └─────────────────────────────┘             │   installs build (U5: release or signed candidate)          │
                                             │   launches Videorc (lab profile, CDP port, journal on)      │
 GitHub                                      │   clicks Go Live via CDP, drives features via remote ctrl   │
 ┌─────────────────────────────┐             │   observes: journal, health events, census (U6)             │
 │ lab-candidate artifacts     │◄────────────│                                                             │
 │ issues (label live-lab)     │◄────────────│ Videorc ─ captures dummy display (test card, U7) ─ RTMPS ───┼─► YouTube @VideorcApp
 │ reports repo + control.json │◄───────────►│           mic = BlackHole fed scripted speech (U7)          │      │
 └─────────────────────────────┘  kill switch│ observer + viewer bot + clip puller (U8, lab GCP project) ◄─┼──────┤
 Discord ◄── P0 ping ──────────────────────  │ verdict + frame checks + report (U9) → publish (U10)        │
                                             │ optional: headless Claude triage (U12)                      │
                                             └─────────────────────────────────────────────────────────────┘
```

### Decisions taken in this plan

- **Go Live through CDP, not a product setting.** Plan 166's S2 would add a
  user-facing "Go Live from remote without confirmation" setting. CDP
  clicks the same dialog users click, works in released builds today, and
  ships nothing new to users. The debugging port binds to loopback, which is
  acceptable on a dedicated machine with no personal data.
- **The owner's policy file is the standing authorization.** Plan 176's
  rule "no stream without the owner's go in the session" becomes "no stream
  outside `policy.json`". The harness enforces it before every run and every
  step. The file is owned by the owner's admin account and is read-only to
  the lab user, so neither the harness nor an agent logged in as the lab user
  can widen it. A writable policy is a refusal, not a warning.
- **The signing key never sits on the lab machine.** Candidates are built
  and Developer-ID signed in CI (U5) and pulled with `gh`. The harness
  verifies the Team ID before installing.
- **Deterministic harness, optional agent.** The schedule runs plain
  scripts. Claude is only needed to start on-demand runs and, optionally, to
  triage reports (U12). An unattended run never depends on an agent making a
  judgement call mid-stream.
- **Manual RTMP first.** Persistent keys with Auto-start cost zero quota and
  need no OAuth. OAuth Go Live is one scenario among many, on the lab
  project.
- **Machine checks replace by-eye checks where possible.** Frame checks on
  pulled clips (U9) cover "is the highlight card on stream", "did the scene
  change", "is the BRB card up". What cannot be automated goes into the
  report's owner digest. It never blocks a run.
- **Everything starts report-only and Unlisted.** Thresholds gate only after
  14 days of data (U15). Public visibility only after D4's bar.

### The policy file (U4)

`/Library/Application Support/VideorcLab/policy.json`, owner-owned, `0644`,
directory not writable by the lab user. Example defaults (D5):

```json
{
  "version": 1,
  "enabled": true,
  "channelHandle": "@VideorcApp",
  "visibility": { "default": "unlisted", "allowPublic": false },
  "titlePrefix": "Automated test",
  "onDemand": {
    "maxRunMinutes": 60,
    "maxRunsPerDay": 8,
    "allowedBuilds": ["release", "candidate"]
  },
  "schedule": { "enabled": true, "timezone": "Europe/Madrid" },
  "quota": { "labProjectMaxUnitsPerDay": 8000, "bundledClientMaxUnitsPerDay": 0 },
  "faults": { "network": false, "process": true },
  "camera": false,
  "killSwitchUrl": "https://raw.githubusercontent.com/<reports-repo>/main/control.json"
}
```

The harness refuses to start, and stops a running stream within 60 s, when
any of these is true: policy missing, unparsable or writable by the lab
user; `enabled: false`; `control.json` says `{"enabled": false}` or cannot be
fetched for 5 minutes while live; `~/videorc-live-lab/STOP` exists; the run
would exceed its minutes, the daily run count or the quota; the requested
visibility or build is not allowed; the stream was ended from YouTube Studio
(read as an incident; no restart until the next scheduled or requested run).

## Owner decisions

Each has a recommendation. D1-D3 block Phase A.

- **D1. The lab machine.** The owner has one. Needed: model (Apple Silicon
  strongly preferred), macOS version, RAM, wired Ethernet or not, and an
  HDMI dummy plug or an always-on monitor. ScreenCaptureKit sees no display
  when the screen is off, and the lock screen covers capture.
- **D2. Lab Google project publishing status.** Recommended: **In
  production, unverified** (about 100 test users max, owner clicks past the
  "unverified app" screen once). Testing mode kills refresh tokens after 7
  days, which breaks every unattended OAuth call weekly. Alternative:
  Testing mode plus a weekly owner re-consent.
- **D3. Viewer account for the chat bot.** Recommended: a new Google account
  ("Videorc Lab Viewer"), not the owner's personal account, because it
  posts unattended. It is added as a test user of the lab project.
- **D4. Visibility.** Recommended: Unlisted for everything until 3 green
  weeks of scheduled runs, then Public for the daily soak only, with
  "Automated test" in every title. On-demand runs stay Unlisted.
- **D5. Policy limits.** Recommended: the defaults in the example above.
- **D6. Candidate builds.** Recommended: CI workflow `lab-candidate-macos`
  (Developer ID signed, not notarized, not published, artifact kept 7 days;
  about 30-40 macOS runner minutes per build). Alternative: the owner's Mac
  builds and pushes over SSH (no CI cost, but the owner's Mac must be on).
- **D7. Where reports live.** Recommended: a **private** repo
  `TheOrcDev/videorc-live-lab-reports` (reports, charts, `control.json`)
  while streams are Unlisted, made public together with D4. Evidence media
  never goes into the main repo (AGENTS.md).
- **D8. Claude on the lab machine (U12).** Recommended: yes, a headless
  Claude Code run after each scheduled run, with a read-only tool allowlist
  plus `gh issue` comment/create. Alternative: triage only from the owner's
  sessions.
- **D9. Schedule.** Recommended (Europe/Madrid): `04:00` update check →
  `04:30` churn (about 75 min) → `06:00` marathon (4 h for the first two
  weeks, then 8 h) → `11:00` idle (2 h) → `13:30` report. Weekly reboot
  Sunday 03:30. On-demand runs are refused while a scheduled run is live
  (one lock).
- **D10. Release gate.** Recommended: after 3 green release-suite runs on 3
  candidates, add "release suite green on the candidate" to the
  `videorc-release` skill (U15).

## Slices

Per the owner's "gates at the end" rule, write and commit every slice in a
phase first, then run the Rust and e2e gates once at the end of the phase.
Unit tests for new harness code run with each slice (they are fast).

### Phase A: on air unattended (manual RTMP, scheduled by hand)

### U0 — Hookup and `live:doctor` (plan 176 L0) — BUILT

Branch `feat/live-lab-l0` (`5353ca22`). As plan 176 L0, plus: `--stream-key
horizontal|vertical --from-clipboard` (Claude Code `!` commands have no
TTY, so keys come from the clipboard, which is cleared after saving);
`--keys-only` / `--client` hidden prompts in a real terminal;
`--client-json <path>` for a downloaded Desktop client;
`--lab-display "<name>"`. Config at `~/.videorc-live-lab/config.json` (dir
0700, file 0600), secrets shown only as last 4. Quota, build TCC and fault
checks print SKIP until U8, U6 and U13 fill them. On the lab machine the
owner runs these at the console during the U3 visit.

**Done when:** plan 176 L0's done-when, run on the lab machine.

### U1 — Metrics journal (plan 166 S1)

Exactly plan 166 S1: NDJSON every 5 s plus one line per health event,
`VIDEORC_METRICS_JOURNAL=1` or setting `diagnostics.metricsJournal`, off by
default, schema v1 with a contract fixture, 200 MB cap, never on the encoder
hot path.

**Done when:** plan 166 S1's done-when.
**STOP if:** plan 166 S1's STOP condition (a lock on the encoder or
compositor hot path).

### U2 — Logs and crash dumps (plan 166 S3)

Exactly plan 166 S3, all three steps: bounded `VIDEORC_BACKEND_LOG_MAX_*`
env, redacted per-session FFmpeg stderr when the journal is on, Electron
`crashReporter` with `uploadToServer: false`.

**Done when:** plan 166 S3's done-when.
**STOP if:** `crashReporter` changes entitlements or needs a new signing
step.

### U3 — Lab machine runbook and machine checks

**Files:** `docs/live-lab-machine.md` (new),
`scripts/live-lab/doctor.mjs` (machine section), `config/live-lab/`
(templates: `policy.example.json`, `com.videorc.live-lab.plist`,
`sudoers.live-lab.example`).

1. Runbook for the one-time visit, in order: macOS admin account (owner) +
   standard account `videorc-lab` (auto-login, FileVault off as an accepted
   trade-off on a machine with no personal data, screen lock off, display
   sleep never, Focus/DND always on, automatic macOS updates off, no iCloud,
   no browser sign-ins, no password manager). Tailscale + SSH key login for
   the lab user only, password SSH off. Homebrew `node pnpm ffmpeg yt-dlp gh
blackhole-2ch`. HDMI dummy as the only display, or the dummy plus a
   monitor that stays off-limits to capture. Clone of the repo at
   `~/videorc`. Install Videorc from videorc.com, launch once, grant Screen
   Recording, Microphone and System Audio. Run `pnpm live:hookup` at the
   console (Google consent needs a browser), then `pnpm live:doctor`.
   Write `policy.json` as the admin user.
2. Doctor machine section (PASS/FAIL): auto-login user is `videorc-lab`;
   screen lock off; display sleep never (`pmset -g`); a display is present
   and awake; DND on; disk free over 100 GB; no Developer ID private key in
   the lab user's keychain (`security find-identity` must not list one);
   policy file present, valid, and not writable by the lab user; lab GCP
   tokens refresh (D2 makes this durable); `gh auth status` scoped to the
   reports repo and issue writes.

**Done when:** doctor is all PASS on the lab machine, and each new check
fails clearly when broken on purpose (lock on, policy chmod 666, display
asleep).
**STOP if:** capture fails with the display awake and unlocked under
auto-login (product bug; file it).

### U4 — Policy, run lock, kill switches, skill update

**Files:** `scripts/live-lab/lib/{policy,run-lock,kill-switch}.mjs` +
tests, `.agents/skills/videorc-live-lab/SKILL.md`, `AGENTS.md` pointer,
`docs/live-lab.md`.

1. `policy.mjs` loads and validates `policy.json` (schema v1 above), checks
   owner and mode with `fs.stat` (refuse if the lab user can write the file
   or its directory), and answers `canStart(request)` and
   `mustStop(runState)` with a reason string.
2. `run-lock.mjs`: one run at a time (`~/videorc-live-lab/run.lock` with
   PID, run id, start time; a stale lock with a dead PID is cleared and
   recorded).
3. `kill-switch.mjs`: STOP file, `control.json` fetch every 60 s (5-minute
   fetch failure while live = stop), Studio-ended detection hook (filled by
   U8), Ctrl-C. Each one ends the stream within 60 s and runs teardown.
4. Skill: add an **Unattended mode** section. On the lab machine, the
   policy replaces the per-run go: Claude may start any run that
   `canStart` allows, without asking. Attended mode (owner's Mac) keeps
   the per-run go. Hard rules 2-8 stay. Add: never edit, copy around, or
   suggest loosening `policy.json` or `control.json` on the owner's
   behalf; a refusal is reported, not worked around.

**Done when:** unit tests cover each refusal reason (writable policy,
disabled, kill switch, over quota, over daily count, public not allowed,
lock held, unreachable control file); the skill diff reads correctly cold.

### U5 — Build delivery: release and signed candidates

**BUILT** (branch `plan-178/u5`): workflow + `live:install` (release,
candidate, rollback) with offline tests; version override via
`extraMetadata.version`. Owed: a first dispatch after merge (dispatch needs
the file on main), then both installs, a TCC-survives-swap check and the
ad-hoc refusal on the lab machine. Candidates must launch with
`VIDEORC_DISABLE_AUTO_UPDATE=1` (U6), or the updater swaps in the release.

**Files:** `.github/workflows/lab-candidate-macos.yml` (new),
`scripts/live-lab/install.mjs` + tests, `package.json` script
`live:install`.

1. Workflow (`workflow_dispatch`, input `ref`): build the macOS app the way
   `release-macos.yml` does, sign with the Developer ID (same secrets), do
   **not** notarize, upload to R2, or touch any release channel. Upload a
   zip as an Actions artifact named `lab-candidate-<shortsha>`, retained 7
   days. Version string `<base>-lab.<shortsha>`.
2. `live:install --build release`: read
   `https://www.videorc.com/api/updates/latest-mac.yml`, download, verify
   `codesign --verify --deep --strict` and `spctl -a -vv`, install.
3. `live:install --build candidate:<run-id|sha>`: `gh run download`, verify
   `codesign` and that the Team ID is `C2PA37RB58`, install. A candidate
   that is not Developer-ID signed is refused (TCC would drop the grants).
4. Install swaps `/Applications/Videorc.app` atomically and keeps the
   previous app for rollback. The run manifest records version, sha and
   source.

**Done when:** a dispatched workflow produces an artifact; install of the
release and of that candidate both pass verification on the lab machine;
TCC grants survive the swap (doctor's 3 s screen-only test recording passes
after each install); an ad-hoc signed app is refused.
**STOP if:** the candidate needs notarization to launch when pulled with
`gh` (no quarantine flag expected), or TCC grants do not survive a
Developer-ID-signed swap.

### U6 — Harness core (plan 176 L2, unattended)

As plan 176 L2 (launch with the lab profile, CDP UI driver, app observer,
teardown, `dry` scenario against a local RTMP sink), plus:

1. Every run goes through `policy.canStart` and takes the run lock; every
   step and a 60 s timer check `policy.mustStop` and the kill switch.
2. Add the missing Go Live dialog `data-testid`s (the only product edit).
3. Holds `caffeinate -d -i -s` for the run. Collects new
   `~/Library/Logs/DiagnosticReports` entries, `backend-crashes.json`,
   Crashpad dumps and logs at teardown.
4. Run folder `~/videorc-live-lab/runs/<date>-<scenario>-<id>/` with
   `manifest.json` (build, harness commit, macOS, hardware, policy hash,
   trigger: schedule / on-demand / manual).

**Done when:** plan 176 L2's done-when, plus `live:run --scenario dry` on
the lab machine with no one present, and a test that a policy flip to
`enabled: false` mid-run stops and tears down within 60 s.

### U7 — Test card and speech rig (plan 176 L3 = plan 166 S6)

As plan 176 L3. Add: the card draws fixed **marker regions** (corner
fiducials, a scene id glyph, a step counter) so U9 can check frames
without OCR, and the card is the only window on the dummy display (doctor
checks the window list on that display).

**Done when:** plan 176 L3's done-when.

### U8a — Phase A acceptance

No new code. `live:run --scenario first-light` (plan 176 suite A) on the
lab machine, Unlisted, manual RTMP, started over SSH by hand with the owner
told but not watching. Then `churn --cycles 3` (plan 166).

**Done when:** both runs go live with no clicks, leave a clean ledger, and
write a complete run folder; YouTube shows completed Unlisted VODs.

### Phase B: YouTube side, reports, on demand, schedule

### U8 — Observer, viewer bot, clip puller, quota ledger (plan 176 L4 = plan 166 S7)

As plan 176 L4, plus: the observer feeds the kill switch's Studio-ended
signal (broadcast `complete` while the app is On air), and the P0 rule from
plan 166 (two `noData` polls while the app reports On air). The viewer bot
uses the D3 account.

**Done when:** plan 176 L4's done-when.
**STOP if:** pulling clips of our own stream is against YouTube's terms for
the channel owner (observer only then).

### U9 — Scenarios, frame checks, verdicts, reports (plan 176 L5 + plan 166 S8 steps 1-2)

**Files:** as plan 176 L5, plus
`scripts/live-lab/scenarios/{marathon,churn,idle,update}.mjs` (from plan
166), `scripts/live-lab/lib/frame-checks.mjs` + tests,
`config/live-lab/thresholds.v1.json`.

1. All plan 176 suites and plan 166 scenarios as step files. Signals and
   first thresholds from plan 166's table, `mode: "report"`.
2. **Frame checks** replace 👁 steps: for each feature event with a
   timestamp (scene applied, takeover shown, comment highlighted, caption
   expected), extract frames from the matching clip at event + 2 s / + 5 s
   and compare the U7 marker regions and a reference crop against a
   baseline frame (perceptual diff with a threshold). Pass / fail /
   `needs-eyes`.
3. Steps that cannot be checked by machine (Studio-only facts, "does it
   look right") are recorded as `needs-eyes` with the frame attached to the
   owner digest in the report. They never block a run or fail a suite.
4. `report.md` + `verdict.json` + charts; redaction pass that fails closed
   on any key-shaped string.

**Done when:** recorded fixture runs (clean; dead leg while On air; chat
message never arrives; highlight card missing from frames) give the
expected verdicts.

### U10 — Remote runner and publishing (plan 166 S8 step 3)

**Files:** `scripts/live-lab/remote.mjs`, `scripts/live-lab/publish.mjs` +
tests, `package.json` scripts `live:remote`, `live:publish`.

1. `pnpm live:remote --host <lab> --scenario <name> [--build
release|candidate:<id>] [--privacy unlisted]` from any dev machine:
   SSH to the lab user, `git -C ~/videorc fetch && checkout` the harness
   commit, run `live:run`, stream progress lines back, and on exit copy back
   only the redacted `report.md` and `verdict.json`. No secret is ever sent
   over the command line; the lab machine holds them all.
2. `live:publish`: redaction pass (fail closed) → push report + charts to
   the reports repo (D7) → for each failure signature, comment on the open
   `live-lab` issue with that signature or open a new one in
   `TheOrcDev/videorc` → Discord webhook on P0 (reuse the
   `scripts/notify-discord-release.mjs` pattern) → update the VOD
   description with the report link (lab project, about 50 units).
3. Skill: on-demand flow ("test PR #N live" → dispatch U5 for the PR head →
   `live:remote` → relay the report and the proposed issues).

**Done when:** a dry-run publish prints the issue it would open; a real
on-demand run started from the owner's Mac publishes a report with no
secrets (redaction test run on the published files).

### U11 — Schedule

**Files:** `config/live-lab/com.videorc.live-lab.plist` (template),
`scripts/live-lab/schedule.mjs` + tests, `package.json` script
`live:schedule`.

1. One launchd agent in the lab user's GUI session (capture needs the
   session), firing every 5 min; `schedule.mjs` decides what is due from
   D9's table, the lock and the policy. A missed slot is skipped, never
   piled up.
2. `live:schedule status` prints the next slots, the last 7 runs with
   verdicts, and today's quota.
3. Weekly reboot through the admin account's `pmset repeat` (runbook
   step), followed by a doctor run at login that publishes FAILs.

**Done when:** one full day of D9's schedule runs untouched and publishes
its reports.

### Phase C: triage, faults, gates

### U12 — Headless Claude triage on the lab machine (D8)

**Files:** `config/live-lab/claude-settings.json` (permission allowlist),
`scripts/live-lab/triage.mjs`, skill section "Triage a run".

1. After `live:publish`, run `claude -p` with the skill's triage prompt,
   the run folder as context, and an allowlist of read-only tools plus
   `gh issue view/comment/create` on `TheOrcDev/videorc`. No edits, no
   git, no SSH, no network beyond GitHub.
2. Triage reads the verdict, looks at `needs-eyes` frames, links failures to
   recent merges (`git log` on the harness clone), and writes a short
   summary comment on the run's issues. It never starts a stream.

**Done when:** triage of a fixture run posts the expected comment in a
test repo; the allowlist blocks an attempted file edit.

### U13 — Fault injection (plan 166 S9)

As plan 166 S9, with network faults gated by `policy.faults.network` and a
scoped sudoers file (exact `dnctl`/`pfctl` commands only, installed by the
owner). Rules are installed with a deadline and removed in `finally` and by
the next doctor.

**Done when:** plan 166 S9's done-when.

### U14 — OAuth Go Live, vertical, scheduled events (plan 176 suites B, F)

Run plan 176 suites B (OAuth Go Live on the lab client) and F (dual
orientation on the second key, scheduled event) on demand. The Studio Dual
stream toggle has no API: the owner turns it on once for the vertical key
during the U3 visit, and the frame checks confirm the vertical output.

**Done when:** both suites are green or every red has an issue.

### U15 — Calibrate, gate, release suite (plan 166 S10 + plan 176 L6)

1. After 14 days of report-only data, `scripts/live-lab/calibrate.mjs`
   proposes `thresholds.v2.json` (`mode: "gate"`, p95 of clean runs plus
   margin). The owner reviews it in one PR.
2. `release` scenario (plan 176 L6) runs on every candidate. The bundled
   client is used only if the owner raises
   `quota.bundledClientMaxUnitsPerDay` (about 300 per run).
3. After 3 green runs on 3 candidates, propose the release-skill gate (D10).

**Done when:** thresholds v2 merged and used by the next 3 runs; one release
suite green on a candidate.

## Out of scope

- Twitch, Kick and X test accounts (follow-up plan on the same harness).
- Windows and Linux lab machines.
- An unattended camera (never) or a live room mic (never). The policy's
  `camera` stays false; an owner-present camera pass is attended mode.
- Any user-facing setting for remote Go Live without confirmation (plan 166
  S2 is dropped).
- Changing defaults for real users. Journal, log size and crash dumps stay
  off or unchanged unless enabled.

## STOP conditions

- Any slice would put a stream key, token, secret, chat identity or home
  path into a log, report, issue, the stream, the reports repo or this repo.
- The harness could start or continue a stream that `policy.json` does not
  allow, or the lab user could write `policy.json`.
- The Developer ID private key would need to live on the lab machine.
- A lab call would spend shared Videorc quota beyond the policy's
  `bundledClientMaxUnitsPerDay`.
- The harness would need to kill a process it did not launch and that is
  not in the owned-process ledger.
- Anything other than the dummy display's test card would be captured.
- A threshold would gate before 14 days of report-only data.

## Verification summary

| Gate                                                                                                                         | Why                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                                           | every TS slice                           |
| `pnpm test:scripts`                                                                                                          | policy, lock, install, harness, verdicts |
| `cargo fmt --check --all`, `cargo test -p videorc-backend metrics_journal`, `cargo clippy -p videorc-backend -- -D warnings` | U1, U2                                   |
| `pnpm --filter @videorc/desktop test`                                                                                        | U2 rotation, U6 test ids                 |
| `pnpm smoke:multistream`, `pnpm smoke:recording-studio` with the journal on                                                  | U1 must not hurt recording or streaming  |
| `pnpm live:doctor` on the lab machine                                                                                        | U0, U3                                   |
| `pnpm live:run --scenario dry` on the lab machine, unattended                                                                | U6                                       |
| U8a runs                                                                                                                     | Phase A                                  |
| One full scheduled day with published reports                                                                                | Phase B                                  |
| Owner acceptance: reads one report, watches one VOD, flips `control.json` off once and sees the stream end within 60 s       | the rig does what this plan says         |

## Model lane note

Per `CLAUDE.md`: U0, U1, U2, U3, U5, U6, U8, U10, U11 are clear
implementation → `gpt-5.5` (fit 7-8). U7's test card is viewer-facing →
`opus-4.8` (fit 8). U4 (the safety boundary and the skill rule change), U9
(verdicts, frame checks), U12 (agent permissions) and U13 (network faults)
→ `fable-5` (fit 9). U8a, U14 and U15 are live, public, judgement-heavy
runs → `fable-5` (fit 9-10).
