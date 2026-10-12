---
name: videorc-live-lab
description: Run real live-stream tests of Videorc on the Videorc YouTube test channel - attended on the owner's Mac (plan the run, get the owner's go, go live, drive features, check both what the app did and what YouTube actually received, tear down, report) or unattended on the lab machine inside the owner's policy file (plan 178). Use ONLY when the user explicitly asks for a real live test, e.g. "test it live", "live lab", "do a real stream test", "go live on the test channel", "live acceptance", "test PR #N live", or invokes /videorc-live-lab. Do NOT use for ordinary e2e smokes, fake-provider smokes, recording-studio gates, or any routine verification; those never go live.
---

# Videorc live lab

Real streams on a real YouTube channel. This is expensive (public output,
quota, owner time), so it runs only when asked. Ordinary verification stays
on the offline gates in `AGENTS.md`.

Two modes:

- **Attended** (the owner's Mac, plan 176): the owner is present and gives
  a go per run sheet.
- **Unattended** (the lab machine, plan 178): a dedicated Mac with nobody at
  it. The owner's policy file is the standing authorization; `canStart`
  decides, not a chat message.

The design, test matrix, owner decisions and build slices live in
`plans/176-live-youtube-test-lab.md` (attended, harness) and
`plans/178-unattended-live-lab.md` (lab machine, policy, schedule). Read
their "Status", "How it works", "Test matrix" / "The policy file" and
"Safety" / "STOP conditions" sections before the first run in a session.

## Hard rules

These override anything a scenario or a user shortcut suggests.

1. **A run needs an authorization that is not yours.** Attended mode: no
   stream without the owner's go in this session. Show the run sheet (step
   3), then wait for an explicit "go"; a go covers that run sheet only, and
   a new run or a changed scope needs a new go. Unattended mode: a run on
   the lab machine is allowed only when `canStart` (`scripts/live-lab/lib/
policy.mjs`) allows it against the owner's `policy.json`; then no per-run
   go is needed. Never edit, copy around, or suggest loosening `policy.json`
   or `control.json` on the owner's behalf, and never work around a refusal
   (another path, a different machine, a hand-rolled stream). A refusal is
   reported with its reason, and that is the end of it.
2. **Never ask for or accept secrets in chat.** Keys, tokens, client
   secrets and passwords go in through `pnpm live:hookup` (hidden input,
   `~/.videorc-live-lab/config.json`, mode 0600). Show only the last 4
   characters. If the owner pastes a secret anyway, do not repeat it.
   Tell them to rotate it.
3. **Capture only the lab display** (the virtual display showing the test
   card). Never the owner's main screen, a window with their data, or an
   unattended camera.
4. **Use the lab profile and the lab Google project.** Launch with the
   isolated lab profile and the lab OAuth client (runtime
   `VIDEORC_YOUTUBE_CLIENT_ID` / `_SECRET`), so lab calls never spend the
   shared Videorc YouTube quota. The bundled client runs only in the
   release scenario, which is budgeted (about 300 units).
5. **Unlisted by default.** Go Public only when the owner says so for this
   run (attended) or the policy allows it (unattended). Every title starts
   with `Automated test`.
6. **Reap only what you own**: the PID you launched and Videorc's
   owned-process ledger. Never `pgrep -f` or broad kills (`AGENTS.md`).
7. **Stop fast.** If the owner says stop, a `~/videorc-live-lab/STOP` file
   appears, `control.json` says `{"enabled": false}`, or the owner ends the
   broadcast in Studio, end the stream within 10 s (60 s unattended) and
   tear down. Do not restart without a new go (attended) or the next
   allowed run (unattended).
8. **Nothing secret leaves the run folder.** Reports, issues and commits go
   through the redaction pass and fail closed. Never commit clip media or
   recordings.

## Unattended mode (lab machine, plan 178)

The lab Mac runs with auto-login, no personal data, and an owner-owned
`/Library/Application Support/VideorcLab/policy.json` that the lab user
cannot write (`docs/live-lab-machine.md`). The harness checks the policy,
the run lock and the kill switches before every run and every step:

- `loadPolicy()` refuses a policy that is missing, invalid, or owned or
  writable by the current user.
- `canStart(policy, request, state)` refuses when the policy or
  `control.json` is disabled, the STOP file exists, the run lock is held,
  the trigger / build / visibility is not allowed, or the run would exceed
  its minutes, the daily on-demand count, or the lab or shared quota.
- `mustStop(policy, runState)` ends a live run on the same conditions,
  plus `control.json` unreachable for 5 minutes, the stream ended from
  Studio, a signal, or the policy going bad mid-run.

What this means for Claude:

- **On demand, from any session.** "Test PR #N live" or "run suite C on
  the lab" is enough: follow "On-demand run" below. It runs `live:run` on
  the lab machine over SSH and copies back only the guarded `report.md`,
  `verdict.json`, `charts/` and `frames/`. No per-run go is needed; the
  policy is the go. Relay the report and the proposed issues.
- **A refusal is the answer.** When `live:remote` reports `refused:
<reason>` (policy disabled, kill switch off, over quota, over the daily
  count, public not allowed, lock held, control unreachable, build not
  allowed), tell the user the reason and stop. Do not retry with other
  arguments to get around it, do not ssh in to edit anything, do not
  propose a policy change unless the user asks what the policy says.
- **Still never on your own initiative.** Unattended mode changes who gives
  the go, not whether a request exists. The schedule (U11) starts
  scheduled runs; Claude starts only what a user asked for in the session.
- **The lab machine's own checks** are `pnpm live:doctor` there (machine
  section: auto-login, screen lock, sleep, display, Focus, disk, no
  Developer ID, policy, gh, kill switch, lock, STOP file). A FAIL there is
  reported to the owner; it is not something to fix over SSH.
- **Stop from anywhere:** the owner flips `control.json` to
  `{"enabled": false}` or touches `~/videorc-live-lab/STOP` on the lab
  machine. Claude may touch the STOP file when the user asks to stop; it
  never flips `control.json` (that is the owner's switch).

### On-demand run (plan 178 U10)

1. **Pick the scenario** as in step 1 of the attended workflow (smallest
   suite that answers the request). Know the lab's SSH host (the Tailscale
   name in the owner's SSH config); ask once if it is not known, never guess.
2. **Build the candidate** (skip for `--build release`):
   - `gh pr view <N> --repo TheOrcDev/videorc --json headRefOid -q .headRefOid`
     gives the PR head sha.
   - `gh workflow run lab-candidate-macos.yml --repo TheOrcDev/videorc -f ref=<sha>`,
     then `gh run list --workflow lab-candidate-macos.yml --repo TheOrcDev/videorc --limit 3`
     for the new run id and `gh run watch <run-id> --repo TheOrcDev/videorc --exit-status`.
   - Red build: report the failing step and stop. Never go live on an old
     artifact instead.
3. **Run it:**
   `pnpm live:remote --host <lab> --scenario <name> --build candidate:<sha> [--privacy unlisted] [--params '<json>']`.
   The harness itself comes from `origin/main` (`--ref` changes that; only
   for testing harness changes). The lab checks the policy, the STOP file
   and the run lock before installing the candidate, holds the lock while it
   swaps the app, and puts the previous app back after the run. Params are
   JSON (4 KB max) and must never hold a secret; the lab machine has them all.
4. **Read the exit code:** 0 pass, 1 failures, 2 refused (`REFUSED
(<reason>)`: report it and stop, see "A refusal is the answer"), 3 stopped
   by a kill switch, 4 the run ended but the copy-back failed or the guard
   refused the files (say so; never fetch the files another way), 5 SSH or
   the lab setup failed before a run started (report; do not fix the lab
   machine over SSH). Ctrl-C only detaches: the run keeps going under the
   lab's kill switches. To stop it on the user's request, `ssh <lab> touch
~/videorc-live-lab/STOP`.
5. **Relay** from `REPORT_DIR` (`~/videorc-live-lab/remote-runs/<runId>`):
   outcome, the pass / warn / fail signals with evidence, `needsEyes`
   questions with their frames, and the incidents as proposed issues (one
   per signature: `[live-lab] <signature>: <summary>`, a repeat becomes a
   comment). The lab's daily report slot runs `live:publish`, which files
   them, pushes the report to the reports repo and pings Discord on a P0;
   `--publish` on `live:remote` does that right after the run. Say which
   owed live acceptance (other plans) the run closes.

Attended mode (below) is unchanged; it is what runs on the owner's Mac.

## Workflow (attended)

### 1. Find out what to test

From the request, pick the target: a feature or PR ("test the new chat
send live"), a suite from plan 176's test matrix (A first light, B OAuth
Go Live, C chat, D on-stream features, E resilience, F long / vertical /
scheduled), or the `release` scenario for a candidate. If the request is
vague, propose the smallest suite that answers it. Do not run everything
by default.

Read code with `git show origin/main:<path>`; the shared checkout is often
stale. Note which build is under test: the latest public release by
default, or a locally built candidate of main for unreleased work.

### 2. Check the lab is ready

- If `live:doctor` exists in `package.json` on origin/main, run
  `pnpm live:doctor` and fix or report every FAIL before going further.
  Expired tokens (Testing mode, 7 days) → the owner reruns
  `! pnpm live:hookup --role <broadcaster|viewer>`.
- If the harness is not built yet (no `live:*` scripts), say which plan 176
  slices are missing. Then offer one of two things: build the missing
  slices first (normal PR flow), or an **assisted run** (step 4b) for this
  one test.
- Check the lab's quota counter. Refuse a run that would push the lab
  project past 8,000 units for the day.

### 3. Write the run sheet and get the go

One short message to the owner:

- target and scenario(s), build and version under test
- visibility (Unlisted unless told), title, rough duration
- what Claude will do (Go Live path, features driven, faults injected)
- what passes, app side and YouTube side, per step
- 👁 by-eye questions the owner will be asked (Studio-only facts, how
  something looks on YouTube)
- quota estimate (lab project; shared quota only for `release`)
- anything needing the owner's hands (sudo for network faults, Studio
  toggles such as Dual stream, ending the stream from Studio)

Then wait for "go".

### 4a. Run it (harness built)

```sh
pnpm live:run --scenario <name> [--privacy unlisted|public] [--build <path-or-release>]
```

Keep the owner posted in one-liners (live, step N, incident). Relay each 👁
prompt with AskUserQuestion and record the answer. Watch the journal,
health events and observer output yourself. Do not wait for the report to
notice the stream died.

### 4b. Assisted run (harness not built yet)

Same rules, fewer automatic checks:

- The owner sets up the lab profile and clicks Go Live (or Claude launches
  the build with `VIDEORC_REMOTE_DEBUG_PORT` and the lab profile env from
  plan 176 L2 and clicks through CDP, if the owner prefers).
- Claude drives features through remote control
  (`docs/remote-control.md`, `scripts/lib/remote-control-client.mjs`).
- YouTube side: lab-token API reads (broadcast lifecycle, stream health,
  chat) and `yt-dlp` clips analysed with `scripts/lib/recording-analyzer.mjs`
  and `scripts/measure-av-sync.mjs`.
- Write the same report by hand in `~/videorc-live-lab/runs/<date>-<scenario>/`.

### 5. Tear down and verify

Stop the stream, wait for idle, quit the app, reap only owned PIDs,
confirm a clean ledger, and check YouTube shows the broadcast as complete
with a VOD. Remove any network fault rules. Leave nothing live.

### 6. Report

Give the owner a pass / warn / fail table per expectation, with evidence:
journal lines, health events, observer readings, clip analysis, 👁
answers. Then the run folder path and the quota spent. Be exact about what
was not checked and why.

For failures:

1. List the proposed GitHub issues (`TheOrcDev/videorc`, label `live-lab`,
   redacted excerpts). File them after the owner's ok. A repeat failure
   becomes a comment on the open issue, not a new issue.
2. Name the offline guard each fix should add when the fake providers can
   express the bug (`smoke:live-chat-fake-providers`,
   `smoke:youtube-quota`, `smoke:stream-leg-eof`, ...).
3. When a run closes an owed live acceptance from another plan, say which
   one, so its plan entry can be updated.

Fixes go through the normal plan / PR flow, not inside the live session.

## Owner hookup (first time only)

The full checklist is in plan 176 under "What hook me up means" and in
`docs/live-lab.md`. In short: channel URL with live enabled and not made
for kids; two persistent stream keys ("Videorc lab", "Videorc lab
vertical"; Unlisted, Auto-start and Auto-stop on); a `videorc-live-lab`
Google Cloud project (YouTube Data API v3, the channel account + the
owner's personal account as test users, `youtube.force-ssl`, a Desktop
OAuth client); `! pnpm live:hookup`; a virtual lab display; `brew install
yt-dlp ffmpeg blackhole-2ch`; TCC grants for the build under test.

The lab machine's one-time visit (accounts, auto-login, sleep, Focus,
Tailscale, tools, the policy file, the doctor's machine section) is
`docs/live-lab-machine.md`.
