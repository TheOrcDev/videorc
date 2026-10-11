---
name: videorc-live-lab
description: Run real, attended live-stream tests of Videorc on the Videorc YouTube test channel - plan the run, get the owner's go, go live, drive features, check both what the app did and what YouTube actually received, tear down, and report. Use ONLY when the user explicitly asks for a real live test, e.g. "test it live", "live lab", "do a real stream test", "go live on the test channel", "live acceptance", or invokes /videorc-live-lab. Do NOT use for ordinary e2e smokes, fake-provider smokes, recording-studio gates, or any routine verification; those never go live.
---

# Videorc live lab

Real streams on a real YouTube channel, with the owner watching. This is
expensive (public output, quota, owner time), so it runs only when asked.
Ordinary verification stays on the offline gates in `AGENTS.md`.

The design, test matrix, owner decisions and build slices live in
`plans/176-live-youtube-test-lab.md`. Read its "Status", "How it works",
"Test matrix" and "Safety" sections before the first run in a session. The
unattended follow-up is plan 166 (`plans/166-*`); this skill never runs
unattended.

## Hard rules

These override anything a scenario or a user shortcut suggests.

1. **No stream without the owner's go in this session.** Show the run sheet
   (step 3), then wait for an explicit "go". A go covers that run sheet
   only. A new run or a changed scope needs a new go.
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
   run. Every title starts with `Automated test`.
6. **Reap only what you own**: the PID you launched and Videorc's
   owned-process ledger. Never `pgrep -f` or broad kills (`AGENTS.md`).
7. **Stop fast.** If the owner says stop, a `~/videorc-live-lab/STOP` file
   appears, or the owner ends the broadcast in Studio, end the stream
   within 10 s and tear down. Do not restart without a new go.
8. **Nothing secret leaves the run folder.** Reports, issues and commits go
   through the redaction pass and fail closed. Never commit clip media or
   recordings.

## Workflow

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

The full checklist is in plan 176 under "What hook me up means". In short:
channel URL with live enabled and not made for kids; two persistent stream
keys ("Videorc lab", "Videorc lab vertical"; Unlisted, Auto-start and
Auto-stop on); a `videorc-live-lab` Google Cloud project (YouTube Data API
v3, Testing mode, the channel account + the owner's personal account as
test users, `youtube.force-ssl`, a Desktop OAuth client);
`! pnpm live:hookup`; a virtual lab display; `brew install yt-dlp ffmpeg
blackhole-2ch`; TCC grants for the build under test.
